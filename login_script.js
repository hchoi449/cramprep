document.addEventListener('DOMContentLoaded', function(){
  const modal = document.getElementById('loginModal');
  const openers = [document.getElementById('login-trigger-desktop'), document.getElementById('login-trigger-mobile')].filter(Boolean);
  const closer = document.querySelector('[data-login-close]');
  function open(){ if(modal){ modal.classList.add('active'); document.body.style.overflow='hidden'; } }
  function close(){ if(modal){ modal.classList.remove('active'); document.body.style.overflow=''; } }
  openers.forEach(el=> el.addEventListener('click', function(e){ e.preventDefault(); open(); }));
  if (closer) closer.addEventListener('click', close);
  modal?.addEventListener('click', (e)=>{ if(e.target===modal) close(); });
});
const wrapper = document.querySelector('.wrapper');
const loginLink = document.querySelector('.login-link');
const registerLink = document.querySelector('.register-link');
const btnPopup = document.querySelector('.btnLogin-popup');
const iconClose = document.querySelector('.icon-close');

registerLink.addEventListener('click', ()=> {
    wrapper.classList.add('active');
});

loginLink.addEventListener('click', ()=> {
    wrapper.classList.remove('active');
});

btnPopup.addEventListener('click', ()=> {
    wrapper.classList.add('active-popup');
});

iconClose.addEventListener('click', ()=> {
    wrapper.classList.remove('active-popup');
    wrapper.classList.remove('active');
});