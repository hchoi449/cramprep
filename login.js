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
                            <input type="email" id="loginEmail" name="email" required aria-required="true" placeholder=" " />
                            <label for="loginEmail">Email</label>
                        </div>
                        <div class="lgn-input-box">
                            <span class="lgn-icon">🔒</span>
                            <input type="password" id="loginPassword" name="password" required aria-required="true" placeholder=" " />
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
                            <input type="text" id="regFullName" name="fullName" required aria-required="true" placeholder=" " />
                            <label for="regFullName">Full Name</label>
                        </div>
                        <div class="lgn-input-box">
                            <span class="lgn-icon">✉️</span>
                            <input type="email" id="regEmail" name="email" required aria-required="true" placeholder=" " />
                            <label for="regEmail">Email</label>
                        </div>
                        <div class="lgn-input-box">
                            <span class="lgn-icon">🔒</span>
                            <input type="password" id="regPassword" name="password" required aria-required="true" placeholder=" " />
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

    function resetAuthForms() {
        if (loginForm) {
            loginForm.reset();
        }
        if (registerForm) {
            registerForm.reset();
        }
    }

    function openOverlay() {
        if (!overlay) return;
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeOverlay() {
        if (!overlay || !wrapper) return;
        // Reset forms so next open starts fresh
        resetAuthForms();
        overlay.classList.remove('active');
        wrapper.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
    if (overlay) overlay.addEventListener('click', function(e) { if (e.target === overlay) closeOverlay(); });

    function validateEmail(email) {
        return /.+@.+\..+/.test(email);
    }

    function getAuthBase() {
        // Allow overriding the auth API base, default to relative CF Pages functions
        return (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
    }

    async function postJson(url, data) {
        const full = url.startsWith('http') ? url : `${getAuthBase()}${url}`;
        const res = await fetch(full, {
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
            const fullName = /** @type {HTMLInputElement} */(document.getElementById('regFullName')).value.trim();
            const email = /** @type {HTMLInputElement} */(document.getElementById('regEmail')).value.trim();
            const password = /** @type {HTMLInputElement} */(document.getElementById('regPassword')).value.trim();
            const terms = /** @type {HTMLInputElement} */(document.getElementById('terms')).checked;

            if (!fullName || !validateEmail(email) || password.length < 6 || !terms) {
                alert('Complete all fields, valid email, password >= 6, and accept terms.');
                return;
            }
            try {
                const resp = await postJson('/api/auth/signup', { email, password, fullName });
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


