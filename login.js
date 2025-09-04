// Login dashboard interactions
(function() {
    const wrapper = document.querySelector('.lgn-wrapper');
    if (!wrapper) return;

    const loginLink = document.querySelector('.lgn-login-link');
    const registerLink = document.querySelector('.lgn-register-link');
    const closeBtn = document.querySelector('.lgn-icon-close');
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

    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            wrapper.classList.remove('active');
        });
    }

    function validateEmail(email) {
        return /.+@.+\..+/.test(email);
    }

    if (loginForm) {
        loginForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const email = /** @type {HTMLInputElement} */(document.getElementById('loginEmail')).value.trim();
            const password = /** @type {HTMLInputElement} */(document.getElementById('loginPassword')).value.trim();

            if (!validateEmail(email) || password.length < 6) {
                alert('Enter a valid email and password (min 6 chars).');
                return;
            }
            // Placeholder: integrate real auth later
            alert('Logged in successfully (demo).');
        });
    }

    if (registerForm) {
        registerForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const username = /** @type {HTMLInputElement} */(document.getElementById('regUsername')).value.trim();
            const email = /** @type {HTMLInputElement} */(document.getElementById('regEmail')).value.trim();
            const password = /** @type {HTMLInputElement} */(document.getElementById('regPassword')).value.trim();
            const terms = /** @type {HTMLInputElement} */(document.getElementById('terms')).checked;

            if (!username || !validateEmail(email) || password.length < 6 || !terms) {
                alert('Complete all fields, valid email, password >= 6, and accept terms.');
                return;
            }
            alert('Registered successfully (demo).');
            wrapper.classList.remove('active');
        });
    }
})();


