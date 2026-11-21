/* ==========================================================================
   FUSTECH Aggregate Calculator | Marvo Tech Lab
   Sections:
   1. Helpers and settings
   2. Intro screen
   3. Light and dark theme
   4. Aggregate calculator (formula from the FUSTECH flyer)
   5. Reviews (live list + success card)
   ========================================================================== */
(function () {
    'use strict';

    /* ======================================================================
       1. HELPERS AND SETTINGS
       ====================================================================== */

    // Shortcut for document.getElementById
    const $ = (id) => document.getElementById(id);

    // True when the visitor's device asks for less animation
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Supabase (database for shared reviews). The publishable key is safe to keep here:
    // the security rules in reviews.sql limit it to adding reviews and reading approved ones.
    const SUPABASE_URL = 'https://ukirglrqvyspvfbcbhca.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_tIrdQDk7lE-ifzmeza2_xQ_Xn29FgUM';

    // localStorage keys
    const THEME_KEY = 'fustech-theme';
    const REVIEWS_KEY = 'fustech-reviews-v1';

    // Safe localStorage read. Returns the fallback if storage is blocked or broken.
    function readStore(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    // Safe localStorage write. Returns true if it saved.
    function writeStore(key, value) {
        try {
            localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Locks a button so it cannot fire twice, and shows a spinner.
     * Returns a function that unlocks it again.
     * @param {HTMLButtonElement} btn
     * @param {string} busyText text shown while locked
     */
    function lockButton(btn, busyText) {
        const label = btn.querySelector('.btn-label');
        const original = label ? label.textContent : '';
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        if (label && busyText) label.textContent = busyText;
        return function unlock() {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            if (label) label.textContent = original;
        };
    }

    // Shows a message under a form. kind is 'error' (default) or 'ok'.
    function setStatus(el, message, kind) {
        el.textContent = message || '';
        el.classList.toggle('is-ok', kind === 'ok');
    }

    // Marks or clears an invalid field for screen readers and styling
    function setInvalid(field, isInvalid) {
        if (isInvalid) field.setAttribute('aria-invalid', 'true');
        else field.removeAttribute('aria-invalid');
    }

    // Small pause helper
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /* ======================================================================
       2. INTRO SCREEN
       Shows the calculator logo and "Built by Marvo Tech Lab" first,
       then fades away and reveals the calculator.
       ====================================================================== */
    const splash = $('splash');
    let splashClosed = false;

    function closeSplash() {
        if (splashClosed) return; // only ever runs once
        splashClosed = true;
        splash.classList.add('is-hidden');
        document.body.classList.remove('is-loading');
        // Remove it from the page after the fade so it cannot block taps
        setTimeout(() => splash.remove(), 700);
    }

    // Auto close after the animation finishes (shorter for reduced motion)
    setTimeout(closeSplash, reduceMotion ? 900 : 2700);
    $('splash-skip').addEventListener('click', closeSplash);

    /* ======================================================================
       3. LIGHT AND DARK THEME
       ====================================================================== */
    const root = document.documentElement;
    const themeBtn = $('theme-toggle');
    const themeMeta = document.querySelector('meta[name="theme-color"]');

    // Applies a theme to the page and keeps the button + browser bar in sync
    function applyTheme(theme) {
        root.setAttribute('data-theme', theme);
        const isDark = theme === 'dark';
        themeBtn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
        if (themeMeta) themeMeta.setAttribute('content', isDark ? '#070d1f' : '#075be8');
    }

    // Set the correct state on load (the tiny script in <head> already picked the theme)
    applyTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

    themeBtn.addEventListener('click', function () {
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        writeStore(THEME_KEY, next);
    });

    /* ======================================================================
       4. AGGREGATE CALCULATOR
       Formula (from the FUSTECH flyer):
         JAMB part    = JAMB score x 70 / 400          (maximum 70)
         O'Level part = sum of five grade points       (maximum 30)
                        A1=6, B2=5, B3=4, C4=3, C5=2, C6=1
         Aggregate    = JAMB part + O'Level part       (maximum 100)
       ====================================================================== */
    const JAMB_MAX = 400;
    const JAMB_WEIGHT = 70;
    const SUBJECT_COUNT = 5;

    // Grade points table. The select values in the HTML use these same numbers.
    const GRADE_LABELS = { 6: 'A1', 5: 'B2', 4: 'B3', 3: 'C4', 2: 'C5', 1: 'C6' };

    const calcForm = $('aggregateCalculator');
    const jambInput = $('jambScore');
    const jambError = $('jambError');
    const calcStatus = $('calcStatus');
    const calcBtn = $('calcBtn');
    const resetBtn = $('resetBtn');
    const olevelLive = $('olevelLive');
    const jambLive = $('jambLive');
    const resultOutput = $('aggregateResult');
    const jambOut = $('jambContribution');
    const olevelOut = $('olevelContribution');
    const totalOut = $('total');
    const gauge = $('gauge');
    const gaugeFill = $('gaugeFill');
    const gradeChips = $('gradeChips');
    const resultHint = $('resultHint');
    const srAnnounce = $('srAnnounce');
    const resultSection = $('result-section');

    // Builds a list of the five { name, input, select } rows
    const subjects = [];
    for (let i = 1; i <= SUBJECT_COUNT; i++) {
        subjects.push({ name: $('subjectName' + i), select: $('subject' + i) });
    }

    // Turns hundredths into text: 1750 -> "17.50"
    const fmt = (hundredths) => (hundredths / 100).toFixed(2);

    /**
     * Calculates the aggregate.
     * Works in hundredths (whole numbers) so rounding never drifts.
     * @param {number} jamb  whole number 0-400
     * @param {number[]} points  five grade points
     * @returns {{jamb:number, olevel:number, total:number}} all in hundredths
     */
    function calculateAggregate(jamb, points) {
        // JAMB x 70 / 400 = JAMB x 0.175 -> in hundredths that is JAMB x 17.5
        const jambPart = Math.round(jamb * (JAMB_WEIGHT * 100 / JAMB_MAX));
        // O'Level points are already out of 30, so they are added as they are
        const olevelPart = points.reduce((sum, p) => sum + p, 0) * 100;
        return { jamb: jambPart, olevel: olevelPart, total: jambPart + olevelPart };
    }

    // Keeps only digits in the JAMB box and caps it at 400 while typing
    jambInput.addEventListener('input', function () {
        let digits = jambInput.value.replace(/\D/g, '').slice(0, 3);
        if (digits !== '' && Number(digits) > JAMB_MAX) digits = String(JAMB_MAX);
        jambInput.value = digits;
        setInvalid(jambInput, false);
        jambError.textContent = '';
        // Live preview of the JAMB part (out of 70)
        jambLive.textContent = fmt(calculateAggregate(Number(digits) || 0, []).jamb);
    });

    // Live "O'Level points so far" counter under the subjects
    function updateLivePoints() {
        const sum = subjects.reduce((s, row) => s + (Number(row.select.value) || 0), 0);
        olevelLive.textContent = sum;
    }
    subjects.forEach((row) => row.select.addEventListener('change', function () {
        setInvalid(row.select, false);
        updateLivePoints();
    }));

    // Checks the form. Returns { ok, jamb, points } or shows what to fix.
    function validateCalculator() {
        let firstBad = null;
        setStatus(calcStatus, '');

        const jambText = jambInput.value.trim();
        const jamb = Number(jambText);
        if (jambText === '' || !Number.isInteger(jamb) || jamb < 0 || jamb > JAMB_MAX) {
            setInvalid(jambInput, true);
            jambError.textContent = 'Enter a whole number from 0 to 400.';
            firstBad = jambInput;
        } else {
            setInvalid(jambInput, false);
            jambError.textContent = '';
        }

        const points = [];
        subjects.forEach(function (row) {
            const value = Number(row.select.value);
            if (!value) {
                setInvalid(row.select, true);
                if (!firstBad) firstBad = row.select;
            } else {
                setInvalid(row.select, false);
                points.push(value);
            }
        });

        if (firstBad) {
            if (points.length < SUBJECT_COUNT && firstBad !== jambInput) {
                setStatus(calcStatus, 'Choose a grade for all five subjects.');
            }
            firstBad.focus();
            return { ok: false };
        }
        return { ok: true, jamb: jamb, points: points };
    }

    // Counts a number up on screen (instant when reduced motion is on)
    function countUp(el, toHundredths, duration, done) {
        if (reduceMotion) { el.textContent = fmt(toHundredths); done(); return; }
        const start = performance.now();
        function frame(now) {
            const t = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3); // ease-out
            el.textContent = fmt(Math.round(toHundredths * eased));
            if (t < 1) requestAnimationFrame(frame);
            else done();
        }
        requestAnimationFrame(frame);
    }

    // Draws the five grade chips under the result
    function renderChips(points) {
        gradeChips.textContent = '';
        points.forEach(function (p, i) {
            const li = document.createElement('li');
            li.style.setProperty('--i', i);
            const name = document.createElement('span');
            name.textContent = subjects[i].name.value.trim() || 'Subject ' + (i + 1);
            const grade = document.createElement('b');
            grade.textContent = GRADE_LABELS[p];
            const pts = document.createElement('em');
            pts.textContent = '+' + p;
            li.append(name, grade, pts);
            gradeChips.appendChild(li);
        });
    }

    // Puts the numbers on screen
    function showResult(jamb, points, result, unlock) {
        jambOut.textContent = fmt(result.jamb);
        olevelOut.textContent = fmt(result.olevel);
        totalOut.textContent = fmt(result.total);
        renderChips(points);

        gauge.classList.remove('is-done');
        gaugeFill.style.strokeDashoffset = 100 - result.total / 100; // fills the ring out of 100
        resultHint.textContent = 'Based on a JAMB score of ' + jamb + ' and ' + (result.olevel / 100) + ' O\u2019Level points.';

        countUp(resultOutput, result.total, 1000, function () {
            gauge.classList.add('is-done');
            srAnnounce.textContent = 'Your aggregate is ' + fmt(result.total) + ' out of 100.';
            unlock(); // button works again only after the animation ends
        });

        // On phones the result sits below the form, so bring it into view
        resultSection.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        resultSection.focus({ preventScroll: true });
    }

    let calculating = false; // second guard against double taps

    calcForm.addEventListener('submit', function (event) {
        event.preventDefault(); // stop the page reloading
        if (calculating) return;

        const check = validateCalculator();
        if (!check.ok) return;

        calculating = true;
        const unlockBtn = lockButton(calcBtn, 'Calculating');
        const result = calculateAggregate(check.jamb, check.points);

        showResult(check.jamb, check.points, result, function () {
            unlockBtn();
            calculating = false;
        });
    });

    // Clear button: wipes the form and puts the result card back to empty
    calcForm.addEventListener('reset', function () {
        if (calculating) return;
        // Wait one tick so the browser clears the inputs first
        setTimeout(function () {
            [jambInput].concat(subjects.map((r) => r.select)).forEach((f) => setInvalid(f, false));
            jambError.textContent = '';
            setStatus(calcStatus, '');
            updateLivePoints();
            jambLive.textContent = '0.00';
            resultOutput.textContent = '--';
            jambOut.textContent = olevelOut.textContent = totalOut.textContent = '-';
            gaugeFill.style.strokeDashoffset = 100;
            gauge.classList.remove('is-done');
            gradeChips.textContent = '';
            srAnnounce.textContent = '';
            resultHint.textContent = 'Fill in the form and tap Calculate to see your score.';
        }, 0);
    });

    /* ======================================================================
       5. REVIEWS
       Reviews are saved in Supabase so every visitor sees them.
       The last list is also kept on the device so the page paints at once,
       even on a slow connection.
       ====================================================================== */
    const openReviewBtn = $('open-review');
    const closeReviewBtn = $('close-review-form');
    const reviewWrapper = $('review-form-wrapper');
    const reviewForm = $('customer-review-form');
    const reviewStatus = $('review-status');
    const reviewSubmit = $('review-submit');
    const reviewMessage = $('review-message');
    const reviewCount = $('review-count');
    const reviewsList = $('reviews-list');
    const reviewsSummary = $('reviews-summary');
    const confirmBox = $('review-confirmation');
    const confirmText = $('review-confirm-text');
    const MIN_REVIEW = 20;

    let reviews = readStore(REVIEWS_KEY, []);
    if (!Array.isArray(reviews)) reviews = [];
    let submittingReview = false;
    let lastFocus = null;
    let newestId = null;

    // Builds one review card. Uses textContent so visitors can never inject HTML.
    function buildReviewCard(review, isNew) {
        const li = document.createElement('li');
        li.className = 'review-card' + (isNew ? ' is-new' : '');
        li.dataset.id = review.id;

        const head = document.createElement('header');
        const name = document.createElement('strong');
        name.textContent = review.name;
        const time = document.createElement('time');
        time.dateTime = new Date(review.date).toISOString();
        time.textContent = new Date(review.date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
        head.append(name, time);

        const stars = document.createElement('div');
        stars.className = 'review-stars';
        stars.setAttribute('role', 'img');
        stars.setAttribute('aria-label', review.rating + ' out of 5 stars');
        for (let i = 1; i <= 5; i++) {
            const star = document.createElement('i');
            star.className = 'fa-solid fa-star' + (i <= review.rating ? '' : ' off');
            star.setAttribute('aria-hidden', 'true');
            stars.appendChild(star);
        }

        const text = document.createElement('p');
        text.textContent = review.message;

        li.append(head, stars, text);
        return li;
    }

    // Redraws the whole list (newest first) and the average line
    function renderReviews() {
        reviewsList.textContent = '';
        reviews.forEach((r) => reviewsList.appendChild(buildReviewCard(r, r.id === newestId)));

        if (!reviews.length) {
            reviewsSummary.textContent = 'No reviews yet. Yours can be the first.';
            return;
        }
        const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
        reviewsSummary.textContent = avg.toFixed(1) + ' out of 5 from ' + reviews.length + (reviews.length === 1 ? ' review' : ' reviews');
    }

    // Opens or closes the review form
    function openReviewForm() {
        reviewWrapper.hidden = false;
        openReviewBtn.setAttribute('aria-expanded', 'true');
        reviewWrapper.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        $('review-name').focus({ preventScroll: true });
    }
    function closeReviewForm() {
        reviewWrapper.hidden = true;
        openReviewBtn.setAttribute('aria-expanded', 'false');
        openReviewBtn.focus({ preventScroll: true });
    }
    openReviewBtn.setAttribute('aria-expanded', 'false');
    openReviewBtn.setAttribute('aria-controls', 'review-form-wrapper');
    openReviewBtn.addEventListener('click', openReviewForm);
    closeReviewBtn.addEventListener('click', closeReviewForm);

    // Live character counter
    reviewMessage.addEventListener('input', function () {
        const len = reviewMessage.value.length;
        reviewCount.textContent = len.toLocaleString('en-US') + ' / 1,000 characters (minimum ' + MIN_REVIEW + ')';
        reviewCount.classList.toggle('is-bad', len > 0 && len < MIN_REVIEW);
        setInvalid(reviewMessage, false);
    });

    // Clears red outlines as people fix fields
    ['review-name', 'review-email'].forEach((id) => $(id).addEventListener('input', (e) => setInvalid(e.target, false)));

    // Checks the review form. Returns the clean data, or null after showing the problem.
    function validateReview() {
        const data = new FormData(reviewForm);
        const name = String(data.get('name') || '').trim();
        const email = String(data.get('email') || '').trim();
        const rating = Number(data.get('rating'));
        const message = String(data.get('review') || '').trim();
        const consent = data.get('publication_consent') === 'yes';

        const nameEl = $('review-name');
        const emailEl = $('review-email');
        [nameEl, emailEl, reviewMessage].forEach((el) => setInvalid(el, false));

        function fail(text, el) {
            setStatus(reviewStatus, text);
            if (el) { setInvalid(el, true); el.focus(); }
            return null;
        }

        if (name.length < 2) return fail('Enter your name (at least 2 letters).', nameEl);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Enter a valid email address.', emailEl);
        if (!rating) return fail('Pick a star rating.', null);
        if (message.length < MIN_REVIEW) return fail('Write at least ' + MIN_REVIEW + ' characters about your experience.', reviewMessage);
        if (!consent) return fail('Tick the box to allow us to publish your review.', null);

        setStatus(reviewStatus, '');
        return { name: name, email: email, rating: rating, message: message };
    }

    // Success card: open, trap focus, close
    function openConfirm(name) {
        lastFocus = document.activeElement;
        confirmText.textContent = 'Thanks, ' + name + '. Your review is now live on this page.';
        confirmBox.hidden = false;
        document.body.style.overflow = 'hidden';
        $('review-confirm-close').focus();
    }
    function closeConfirm(scrollToReview) {
        if (confirmBox.hidden) return;
        confirmBox.hidden = true;
        document.body.style.overflow = '';
        if (scrollToReview && newestId) {
            const card = reviewsList.querySelector('[data-id="' + newestId + '"]');
            if (card) card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        } else if (lastFocus) {
            lastFocus.focus({ preventScroll: true });
        }
    }
    $('review-confirm-close').addEventListener('click', () => closeConfirm(true));
    $('review-confirm-x').addEventListener('click', () => closeConfirm(false));
    confirmBox.addEventListener('click', (e) => { if (e.target === confirmBox) closeConfirm(false); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            if (!confirmBox.hidden) closeConfirm(false);
            else if (!reviewWrapper.hidden) closeReviewForm();
        }
        // Keep Tab inside the success card while it is open
        if (e.key === 'Tab' && !confirmBox.hidden) {
            const items = confirmBox.querySelectorAll('button');
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });

    // Headers every Supabase request needs
    const sbHeaders = {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
    };

    // Saves one review in the Supabase "reviews" table. Throws if it fails.
    async function sendToServer(review, email) {
        const res = await fetch(SUPABASE_URL + '/rest/v1/reviews', {
            method: 'POST',
            headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders),
            body: JSON.stringify({
                name: review.name,
                email: email,
                rating: review.rating,
                message: review.message
            })
        });
        if (!res.ok) throw new Error('Supabase said ' + res.status);
    }

    // Loads the latest approved reviews (everyone's) and shows them
    async function loadReviews() {
        try {
            const url = SUPABASE_URL + '/rest/v1/public_reviews' +
                '?select=id,name,rating,message,created_at&order=created_at.desc&limit=50';
            const res = await fetch(url, { headers: sbHeaders });
            if (!res.ok) throw new Error('Supabase said ' + res.status);
            const rows = await res.json();
            if (!Array.isArray(rows)) return;

            reviews = rows.map((r) => ({
                id: String(r.id),
                name: String(r.name),
                rating: Number(r.rating),
                message: String(r.message),
                date: r.created_at
            }));
            writeStore(REVIEWS_KEY, reviews); // keep a copy for the next fast load
            renderReviews();
        } catch (err) {
            // Offline or blocked: keep showing whatever is already on screen
        }
    }

    reviewForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (submittingReview) return; // ignore a second tap

        // Spam trap: bots fill the hidden field, people never see it
        if (reviewForm.elements.website.value) return;

        const clean = validateReview();
        if (!clean) return;

        submittingReview = true;
        const unlock = lockButton(reviewSubmit, 'Publishing');

        const review = {
            id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: clean.name,
            rating: clean.rating,
            message: clean.message,
            date: new Date().toISOString()
        };

        try {
            await sendToServer(review, clean.email); // email goes to the database only, never shown
            if (!reduceMotion) await wait(500); // brief beat so the spinner is seen

            reviews.unshift(review);          // newest first
            reviews = reviews.slice(0, 50);   // keep the list light
            writeStore(REVIEWS_KEY, reviews);
            newestId = review.id;
            renderReviews();                  // review appears on the page immediately

            reviewForm.reset();
            reviewCount.textContent = '0 / 1,000 characters (minimum ' + MIN_REVIEW + ')';
            reviewCount.classList.remove('is-bad');
            reviewWrapper.hidden = true;
            openReviewBtn.setAttribute('aria-expanded', 'false');
            openConfirm(review.name.split(' ')[0]);
        } catch (err) {
            setStatus(reviewStatus, 'We could not send your review. Check your connection and try again.');
        } finally {
            unlock();
            submittingReview = false;
        }
    });

    /* ======================================================================
       START UP
       ====================================================================== */
    $('year').textContent = new Date().getFullYear();
    updateLivePoints();
    renderReviews();   // instant: last saved list
    loadReviews();     // then refresh with everyone's reviews
})();
