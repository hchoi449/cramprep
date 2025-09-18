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
    // Create loading overlay once
    let loading = document.querySelector('.lgn-loading');
    if (!loading) {
        loading = document.createElement('div');
        loading.className = 'lgn-loading';
        loading.innerHTML = '<div class="tbp-star-spinner" aria-label="Loading"></div>';
        document.body.appendChild(loading);
    }

    function showLoading(show) {
        if (!loading) return;
        if (show) loading.classList.add('active');
        else loading.classList.remove('active');
    }

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
        // Warm up API to avoid cold-start timeouts
        try { pingAuth(); } catch {}
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

    // Close login on ESC
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { try { closeOverlay(); } catch{} } });

    function validateEmail(email) {
        return /.+@.+\..+/.test(email);
    }

    function getAuthBase() {
        // Allow overriding the auth API base, default to relative CF Pages functions
        return (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
    }

    async function postJson(url, data) {
        const full = url.startsWith('http') ? url : `${getAuthBase()}${url}`;
        const controller = new AbortController();
        const timeout = setTimeout(()=> controller.abort(), 15000);
        showLoading(true);
        try {
            const res = await fetch(full, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
                signal: controller.signal
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(json.error || 'Request failed');
            }
            return json;
        } catch (err) {
            const msg = (err && err.name === 'AbortError') ? 'Request timed out' : (err && err.message) || 'Network error';
            throw new Error(msg);
        } finally {
            clearTimeout(timeout);
            showLoading(false);
        }
    }

    function extractFirstName(nameOrEmail) {
        if (!nameOrEmail) return '';
        const name = String(nameOrEmail);
        if (name.includes(' ')) return name.split(' ')[0];
        if (name.includes('@')) return name.split('@')[0];
        return name;
    }

    function renderGreeting(fullName, email) {
        const first = extractFirstName(fullName || email);
        const wrap = document.createElement('div');
        wrap.style.position = 'relative';

        const greeting = document.createElement('button');
        greeting.className = 'header-greeting';
        greeting.textContent = `Hi ${first}`;
        greeting.type = 'button';

        const menu = document.createElement('div');
        menu.className = 'greeting-dropdown';

        function makeItem(label, href, handler) {
            const a = document.createElement('a');
            a.href = href || '#';
            a.textContent = label;
            if (handler) a.addEventListener('click', handler);
            return a;
        }

        const profile = makeItem('My Account', 'account.html');
        const settings = makeItem('Settings', 'settings.html');
        const help = makeItem('Help', '#help');
        const logout = makeItem('Log out', '#logout', function(e){
            e.preventDefault();
            try { localStorage.removeItem('tbp_token'); localStorage.removeItem('tbp_user'); } catch {}
            // Redirect to homepage unsigned
            window.location.href = 'index.html#home';
        });
        menu.appendChild(profile);
        menu.appendChild(settings);
        menu.appendChild(help);
        menu.appendChild(logout);

        greeting.addEventListener('click', function(){
            menu.classList.toggle('active');
        });

        document.addEventListener('click', function(e){
            if (!wrap.contains(e.target)) menu.classList.remove('active');
        });

        wrap.appendChild(greeting);
        wrap.appendChild(menu);
        return wrap;
    }

    function setUserGreeting(user) {
        try {
            // Desktop nav replacement (avoid duplicates)
            const desktopNav = document.querySelector('.nav-desktop');
            if (desktopNav) {
                const existing = desktopNav.querySelector('.header-greeting');
                if (existing) return; // already rendered
                const loginLinkDesktop = desktopNav.querySelector('.student-login-link');
                const el = renderGreeting(user.fullName, user.email);
                if (loginLinkDesktop && loginLinkDesktop.parentNode) {
                    loginLinkDesktop.parentNode.replaceChild(el, loginLinkDesktop);
                } else {
                    desktopNav.appendChild(el);
                }
            }
            // Mobile nav (avoid duplicates)
            const mobileMenu = document.getElementById('mobile-menu');
            if (mobileMenu) {
                const existingMob = mobileMenu.querySelector('.header-greeting');
                if (!existingMob) {
                    const mobileLogin = Array.from(mobileMenu.querySelectorAll('a')).find(a => (a.textContent||'').toLowerCase().includes('student login'));
                    const elMob = renderGreeting(user.fullName, user.email);
                    if (mobileLogin && mobileLogin.parentNode) {
                        mobileLogin.parentNode.replaceChild(elMob, mobileLogin);
                    } else {
                        mobileMenu.appendChild(elMob);
                    }
                }
            }
        } catch {}
    }

    async function tryRestoreSession() {
        try {
            const raw = localStorage.getItem('tbp_user');
            const token = localStorage.getItem('tbp_token');
            if (!raw || !token) return;
            // Optionally verify token
            const res = await fetch(`${getAuthBase()}/auth/me`, { headers: { 'Authorization': `Bearer ${token}` } });
            const j = await res.json().catch(() => ({}));
            if (res.ok && j && j.authenticated) {
                const user = JSON.parse(raw);
                setUserGreeting(user);
            }
        } catch {}
    }

    // Attempt to restore session on load
    tryRestoreSession();

    async function pingAuth(){
        try {
            const base = getAuthBase();
            if (!base) return;
            const res = await fetch(`${base}/auth/ping`, { cache:'no-store' });
            if (!res.ok) throw new Error('offline');
        } catch {}
    }
    // Ping in background on page load
    pingAuth();

    if (loginForm) {
        loginForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const email = /** @type {HTMLInputElement} */(document.getElementById('loginEmail')).value.trim();
            const password = /** @type {HTMLInputElement} */(document.getElementById('loginPassword')).value.trim();


            if (!validateEmail(email) || password.length < 6) {
                showNotification('Enter a valid email and password', 'error');
                return;
            }
            try {
                const resp = await postJson('/auth/login', { email, password });
                try { localStorage.setItem('tbp_token', resp.token || ''); localStorage.setItem('tbp_user', JSON.stringify(resp.user || {})); } catch {}
                setUserGreeting(resp.user || { email });
                // Notify listeners (e.g., chatbot) that login completed
                try { window.dispatchEvent(new CustomEvent('tbp:auth:login', { detail: { user: resp.user || { email } } })); } catch {}
                closeOverlay();
            } catch (err) {
                const msg = (err && err.message ? String(err.message) : '').toLowerCase();
                if (msg.includes('invalid credential')) {
                    showNotification('Enter a valid email and password', 'error');
                } else {
                    showNotification((err && err.message) || 'Login failed. Please check your email and password.', 'error');
                }
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

            if (!fullName) { showNotification('Please enter your full name.', 'error'); return; }
            if (!validateEmail(email)) { showNotification('Please enter a valid email address.', 'error'); return; }
            if (password.length < 6) { showNotification('Password must be at least 6 characters.', 'error'); return; }
            if (!terms) { showNotification('Please agree to the terms & conditions to proceed.', 'error'); return; }
            try {
                const resp = await postJson('/auth/signup', { email, password, fullName });
                showNotification('🎉 Registration successful! You can now log in.', 'success', 4000);
                wrapper.classList.remove('active');
                closeOverlay();
            } catch (err) {
                showNotification((err && err.message) || 'Registration failed. Please try again.', 'error');
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


