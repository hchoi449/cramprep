// Login dashboard interactions
(function() {
    // If the login modal is not present, inject it into the DOM so any page can use it
    function injectLoginModalIfNeeded() {
        if (document.querySelector('.lgn-overlay')) return;
        const overlay = document.createElement('div');
        overlay.className = 'lgn-overlay';
        overlay.innerHTML = `
            <div class="lgn-wrapper" aria-live="polite" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
                <button class="lgn-icon-close" aria-label="Close login">×</button>
                <div class="lgn-form-box lgn-login">
                    <h2 id="loginTitle">Login</h2>
                    <form id="loginForm" novalidate>
                        <div class="lgn-input-box">
                            <span class="lgn-icon">✉️</span>
                            <input type="email" id="loginEmail" name="email" required aria-required="true" />
                            <label for="loginEmail">Email</label>
                        </div>
                        <div class="lgn-input-box">
                            <span class="lgn-icon">🔒</span>
                            <input type="password" id="loginPassword" name="password" required aria-required="true" />
                            <label for="loginPassword">Password</label>
                        </div>
                        <div class="lgn-remember-forgot">
                            <label><input type="checkbox" id="rememberMe" /> Remember me</label>
                            <a href="#" aria-label="Forgot password">Forgot Password?</a>
                        </div>
                        <button type="submit" class="lgn-btn">Login</button>
                        <div class="lgn-login-register">
                            <p>Don't have an account? <a href="#" class="lgn-register-link">Register</a></p>
                        </div>
                    </form>
                </div>
                <div class="lgn-form-box lgn-register" role="region" aria-labelledby="registerTitle">
                    <h2 id="registerTitle">Registration</h2>
                    <form id="registerForm" novalidate>
                        <div class="lgn-input-box">
                            <span class="lgn-icon">👤</span>
                            <input type="text" id="regUsername" name="username" required aria-required="true" />
                            <label for="regUsername">Username</label>
                        </div>
                        <div class="lgn-input-box">
                            <span class="lgn-icon">✉️</span>
                            <input type="email" id="regEmail" name="email" required aria-required="true" />
                            <label for="regEmail">Email</label>
                        </div>
                        <div class="lgn-input-box">
                            <span class="lgn-icon">🔒</span>
                            <input type="password" id="regPassword" name="password" required aria-required="true" />
                            <label for="regPassword">Password</label>
                        </div>
                        <div class="lgn-remember-forgot">
                            <label><input type="checkbox" id="terms" required aria-required="true" /> I agree to the terms & conditions</label>
                        </div>
                        <button type="submit" class="lgn-btn">Register</button>
                        <div class="lgn-login-register">
                            <p>Already have an account? <a href="#" class="lgn-login-link">Login</a></p>
                        </div>
                    </form>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    injectLoginModalIfNeeded();

    const overlay = document.querySelector('.lgn-overlay');
    const wrapper = overlay ? overlay.querySelector('.lgn-wrapper') : null;

    const loginLink = document.querySelector('.lgn-login-link');
    const registerLink = document.querySelector('.lgn-register-link');
    const closeBtn = overlay ? overlay.querySelector('.lgn-icon-close') : null;
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    if (registerLink) {
        registerLink.addEventListener('click', function(e) {
            e.preventDefault();
            wrapper.classList.add('active');
        });
    }

    if (loginLink) {
        loginLink.addEventListener('click', function(e) {
            e.preventDefault();
            wrapper.classList.remove('active');
        });
    }

    function openOverlay() {
        if (!overlay) return;
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeOverlay() {
        if (!overlay || !wrapper) return;
        overlay.classList.remove('active');
        wrapper.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
    if (overlay) overlay.addEventListener('click', function(e) { if (e.target === overlay) closeOverlay(); });

    function validateEmail(email) {
        return /.+@.+\..+/.test(email);
    }

    async function postJson(url, data) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(json.error || 'Request failed');
        }
        return json;
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const email = /** @type {HTMLInputElement} */(document.getElementById('loginEmail')).value.trim();
            const password = /** @type {HTMLInputElement} */(document.getElementById('loginPassword')).value.trim();

            if (!validateEmail(email) || password.length < 6) {
                alert('Enter a valid email and password (min 6 chars).');
                return;
            }
            try {
                const resp = await postJson('/api/auth/login', { email, password });
                alert('Logged in successfully.');
                closeOverlay();
            } catch (err) {
                alert((err && err.message) || 'Login failed');
            }
        });
    }

    if (registerForm) {
        registerForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const username = /** @type {HTMLInputElement} */(document.getElementById('regUsername')).value.trim();
            const email = /** @type {HTMLInputElement} */(document.getElementById('regEmail')).value.trim();
            const password = /** @type {HTMLInputElement} */(document.getElementById('regPassword')).value.trim();
            const terms = /** @type {HTMLInputElement} */(document.getElementById('terms')).checked;

            if (!username || !validateEmail(email) || password.length < 6 || !terms) {
                alert('Complete all fields, valid email, password >= 6, and accept terms.');
                return;
            }
            try {
                const resp = await postJson('/api/auth/signup', { email, password, username });
                alert('Registered successfully.');
                wrapper.classList.remove('active');
                closeOverlay();
            } catch (err) {
                alert((err && err.message) || 'Registration failed');
            }
        });
    }

    // Hook all Student Login links globally
    document.addEventListener('click', function(e) {
        const target = e.target.closest('a');
        if (!target) return;
        const isLoginLink = target.classList.contains('student-login-link') || (target.getAttribute('href') || '').endsWith('login.html');
        if (isLoginLink) {
            e.preventDefault();
            openOverlay();
        }
    });
})();


