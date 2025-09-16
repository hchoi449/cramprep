/* Ported CodingNepal chatbot with Gemini API flow; adapted to our Schedule AI button */
(function(){
  // Load required icon fonts
  const iconHref = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0&family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@48,400,1,0';
  if (!document.querySelector(`link[href^="${iconHref}"]`)) {
    const lf = document.createElement('link'); lf.rel='stylesheet'; lf.href=iconHref; document.head.appendChild(lf);
  }
  // (Removed) Emoji picker and attachments not used

  // Inject DOM
  const root = document.createElement('div');
  root.innerHTML = `
  <div class="chatbot-popup">
    <div class="chat-header">
      <div class="header-info">
        <svg class="chatbot-logo" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9zM351.7 448.2c0-29.5 23.9-53.5 53.5-53.5s53.5 23.9 53.5 53.5-23.9 53.5-53.5 53.5-53.5-23.9-53.5-53.5zm157.9 267.1c-67.8 0-123.8-47.5-132.3-109h264.6c-8.6 61.5-64.5 109-132.3 109zm110-213.7c-29.5 0-53.5-23.9-53.5-53.5s23.9-53.5 53.5-53.5 53.5 23.9 53.5 53.5-23.9 53.5-53.5 53.5z"/></svg>
        <h2 class="logo-text">Chatbot</h2>
      </div>
      <button id="close-chatbot" class="material-symbols-rounded">close</button>
    </div>
    <div class="chat-body"></div>
    <div class="chat-footer">
      <form action="#" class="chat-form">
        <textarea placeholder="Message..." class="message-input" required></textarea>
        <div class="chat-controls">
          <button type="submit" id="send-message" class="material-symbols-rounded">arrow_upward</button>
        </div>
      </form>
    </div>
  </div>`;

  function mount(){
    // overlay for outside click to close
    let overlay = document.querySelector('.tbp-chat-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'tbp-chat-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', ()=> document.body.classList.remove('show-chatbot'));
    }
    document.body.appendChild(root);
    wireLogic(root);
  }

  function wireLogic(root){
    const chatBody = root.querySelector('.chat-body');
    const messageInput = root.querySelector('.message-input');
    const sendMessage = root.querySelector('#send-message');
    // Optional file-upload elements (may not exist in our UI)
    const fileInput = root.querySelector('#file-input');
    const fileUploadWrapper = root.querySelector('.file-upload-wrapper');
    const fileCancelButton = fileUploadWrapper ? fileUploadWrapper.querySelector('#file-cancel') : null;
    const fileUploadButton = root.querySelector('#file-upload');
    const chatbotToggler = document.getElementById('ai-chat-open');
    const closeChatbot = root.querySelector('#close-chatbot');

    // API
    const API_KEY_PLACEHOLDER = 'PASTE-YOUR-API-KEY';
    const API_KEY = window.TBP_GEMINI_API_KEY || API_KEY_PLACEHOLDER;
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

    const userData = { message: null, file: { data:null, mime_type:null } };
    const SEED_PROMPT = "You are ThinkBigPrep's scheduling assistant. Help students book sessions. Keep every reply within 300 characters. If the student's profile is available, do not ask for their name, school, or grade; use the provided profile data. Ask only what is necessary (subject, help type, preferred day/time). Be friendly and professional.";
    const chatHistory = [];
    // Seed assistant role and constraints
    chatHistory.push({ role: 'model', parts: [{ text: SEED_PROMPT }] });
    const initialInputHeight = messageInput.scrollHeight;

    let userIsAuthed = false;
    let cachedProfile = null;
    let hasAskedHelp = false;
    let helpTopic = null;
    let contextHelpType = null;
    let contextSubject = null;
    let loginPromptShown = false;

    const createMessageElement = (content, ...classes) => { const div = document.createElement('div'); div.classList.add('message', ...classes); div.innerHTML = content; return div; };

    async function fetchAvailability(days=7, dayStart=12, dayEnd=24){
      try {
        const res = await fetch('/api/events', { headers: { Accept:'application/json' } });
        if (!res.ok) return [];
        const { events } = await res.json();
        const tz = 'America/New_York';
        const now = new Date();
        const busy = events.map(ev=>({ s:new Date(ev.start), e:new Date(ev.end) }));
        const freeSlots = [];
        for(let i=0;i<days;i++){
          const base = new Date(now); base.setDate(now.getDate()+i);
          const parts = new Intl.DateTimeFormat('en-US',{ timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(base).reduce((a,p)=> (a[p.type]=p.value,a),{});
          for (let h=dayStart; h<dayEnd; h++){
            const hour = String(h%24).padStart(2,'0');
            const start = new Date(`${parts.year}-${parts.month}-${parts.day}T${hour}:00:00-05:00`);
            const end = new Date(`${parts.year}-${parts.month}-${parts.day}T${hour}:59:59-05:00`);
            const overlaps = busy.some(b=> !(b.e<=start || b.s>=end));
            if (!overlaps) freeSlots.push(start);
          }
        }
        const fmt = new Intl.DateTimeFormat('en-US',{ timeZone: tz, weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
        return freeSlots.slice(0,8).map(d0=> fmt.format(d0));
      } catch { return []; }
    }

    async function fetchSessionsUntil(deadlineIso){
      try {
        const AUTH_BASE = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
        const res = await fetch(`${AUTH_BASE}/sessions`, { headers: { Accept:'application/json' } });
        if (!res.ok) return [];
        const j = await res.json();
        const events = (j && j.events) ? j.events : [];
        const now = new Date();
        const deadline = deadlineIso ? new Date(deadlineIso) : new Date(now.getTime() + 7*86400000);
        return events
          .map(ev => ({ start: new Date(ev.start), end: new Date(ev.end), title: ev.title }))
          .filter(ev => ev.start >= now && ev.start <= deadline)
          .sort((a,b)=> a.start - b.start)
          .map(ev => ev.start);
      } catch { return []; }
    }

    async function getProfile(){
      try {
        const token = localStorage.getItem('tbp_token');
        if (!token) return null;
        const AUTH_BASE = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
        const res = await fetch(`${AUTH_BASE}/auth/profile`, { headers: { 'Authorization': `Bearer ${token}` } });
        const j = await res.json().catch(()=>({}));
        if (res.ok && j && j.profile) return j.profile;
      } catch {}
      return null;
    }

    function setAuthUI(authed){
      userIsAuthed = !!authed;
      if (!userIsAuthed) {
        messageInput.disabled = true;
        sendMessage.disabled = true;
        messageInput.placeholder = 'Please log in or sign up to continue scheduling.';
      } else {
        messageInput.disabled = false;
        sendMessage.disabled = false;
        messageInput.placeholder = 'Message...';
      }
    }

    function renderLoginPromptOnce(){
      if (loginPromptShown) return;
      const div = createMessageElement(`<div class=\"message-text\">Please log in or sign up to continue scheduling. <a href=\"#\" class=\"open-login\">Open login</a></div>`, 'bot-message');
      chatBody.appendChild(div);
      const link = div.querySelector('.open-login');
      if (link) link.addEventListener('click', function(e){ e.preventDefault();
        try {
          const a = document.querySelector('.student-login-link');
          if (a) a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch {}
      });
      chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
      loginPromptShown = true;
    }

    async function generateBotResponse(incomingMessageDiv){
      const messageElement = incomingMessageDiv.querySelector('.message-text');
      chatHistory.push({ role:'user', parts:[{ text: userData.message }, ...(userData.file.data ? [{ inline_data: userData.file }] : [])] });
      // Provide strict available sessions only from timetable (/sessions)
      try {
        if (helpTopic) {
          chatHistory.push({ role:'user', parts:[{ text: `HelpTopic: ${helpTopic}` }] });
        }
        if (contextHelpType) {
          chatHistory.push({ role:'user', parts:[{ text: `HelpType: ${contextHelpType}` }] });
        }
        if (contextSubject) {
          chatHistory.push({ role:'user', parts:[{ text: `Subject: ${contextSubject}` }] });
        }
        const free = await fetchSessionsUntil();
        const fmt = new Intl.DateTimeFormat('en-US',{ timeZone:'America/New_York', weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        const choices = (free || []).slice(0, 8).map(d=> fmt.format(d));
        const firstName = cachedProfile && cachedProfile.fullName ? (String(cachedProfile.fullName).trim().split(' ')[0] || 'there') : 'there';
        const school = cachedProfile && cachedProfile.school ? cachedProfile.school : 'N/A';
        const grade = cachedProfile && cachedProfile.grade ? cachedProfile.grade : 'N/A';
        const authRule = userIsAuthed ? '' : `\nIf NotLoggedIn: Reply EXACTLY: Please log in or sign up to continue scheduling.`;
        const instruction = `StudentFirstName: ${firstName}\nSchool: ${school}\nGrade: ${grade}\nAvailableSlotsEST (choose only from this list exactly): [${choices.map(c=>`"${c}"`).join(', ')}]\nRules:\n- If NotLoggedIn, follow the auth instruction above and stop.\n- If the list is not empty, reply with EXACTLY: Hi ${firstName}! How about <OneOfTheListedSlots>?\n- The <OneOfTheListedSlots> must be copied verbatim from the list above (no new times).\n- Prefer the earliest item in the list.\n- If the user says none of the options work OR the list is empty, reply EXACTLY: Help is on the way. Someone from our team will contact you through your email as soon as possible.${authRule}`;
        chatHistory.push({ role:'user', parts:[{ text: instruction }] });
      } catch {}
      const requestOptions = { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ contents: chatHistory }) };
      try {
        const response = await fetch(API_URL, requestOptions);
        const data = await response.json();
        if (!response.ok) throw new Error((data && data.error && data.error.message) || 'API error');
        const apiResponseText = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text || '').replace(/\*\*(.*?)\*\*/g,'$1').trim();
        const constrained = apiResponseText ? apiResponseText.slice(0, 300) : '';
        messageElement.innerText = constrained || '...';
        chatHistory.push({ role:'model', parts:[{ text: constrained }] });
        // If model signals fallback, trigger notify
        if (/Help is on the way\. Someone from our team will contact you through your email as soon as possible\./i.test(constrained)) {
          if (window.tbpFallbackNotify) try { await window.tbpFallbackNotify(); } catch {}
        }
      } catch (err) {
        messageElement.innerText = (err && err.message) || 'Request failed';
        messageElement.style.color = '#ff0000';
      } finally {
        userData.file = {};
        incomingMessageDiv.classList.remove('thinking');
        chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
      }
    }

    function detectHelpType(text){
      if (!text) return null;
      const t = String(text).toLowerCase();
      if (/\b(homework|assignment|hw)\b/.test(t)) return 'homework';
      if (/\b(quiz|quizzes)\b/.test(t)) return 'quiz';
      if (/\b(exam|test|assessment|assessments)\b/.test(t)) return 'exam';
      if (/\b(project|paper|lab)\b/.test(t)) return 'project';
      return null;
    }
    function detectSubject(text){
      if (!text) return null;
      const t = String(text).toLowerCase();
      if (/\b(pre[- ]?calculus|precalculus|calculus|algebra|geometry|math|mathematics)\b/.test(t)) return 'Math';
      if (/\b(physics)\b/.test(t)) return 'Physics';
      if (/\b(chemistry|chem)\b/.test(t)) return 'Chemistry';
      if (/\b(biology|bio)\b/.test(t)) return 'Biology';
      if (/\b(english|ela)\b/.test(t)) return 'English';
      if (/\b(history)\b/.test(t)) return 'History';
      if (/\b(computer\s*science|cs|programming|coding)\b/.test(t)) return 'Computer Science';
      if (/\b(sat)\b/.test(t)) return 'SAT';
      if (/\b(act)\b/.test(t)) return 'ACT';
      return null;
    }

    async function handleOutgoingMessage(e){
      e.preventDefault();
      // Block sending if not authenticated
      if (!userIsAuthed) { renderLoginPromptOnce(); return; }
      userData.message = messageInput.value.trim();
      if (!userData.message) return;
      messageInput.value = '';
      messageInput.dispatchEvent(new Event('input'));
      if (fileUploadWrapper) fileUploadWrapper.classList.remove('file-uploaded');
      const messageContent = `<div class=\"message-text\"></div>${userData.file.data ? `<img src=\"data:${userData.file.mime_type};base64,${userData.file.data}\" class=\"attachment\" />` : ''}`;
      const outgoingMessageDiv = createMessageElement(messageContent, 'user-message');
      outgoingMessageDiv.querySelector('.message-text').innerText = userData.message;
      chatBody.appendChild(outgoingMessageDiv);
      chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });

      // If we've asked for help topic and none captured yet, intercept greetings/short replies
      if (hasAskedHelp && !helpTopic) {
        const looksGreeting = /^(hi|hey|hello|yo|sup|good\s*(morning|afternoon|evening))\b/i.test(userData.message);
        const hasKeywords = /(homework|exam|test|quiz|assessment|assignment|project|paper|lab|due|study|help)\b/i.test(userData.message);
        if (!hasKeywords && (looksGreeting || userData.message.length < 15)) {
          const ask = createMessageElement(`<div class=\"message-text\">Got it. What do you need help with? (e.g., Algebra homework due Thu)</div>`, 'bot-message');
          chatBody.appendChild(ask);
          chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
          return;
        }
        helpTopic = userData.message;
      }

      // Extract structured context from any message
      const ht = detectHelpType(userData.message); if (ht && !contextHelpType) contextHelpType = ht;
      const sj = detectSubject(userData.message); if (sj && !contextSubject) contextSubject = sj;
      // If missing details, let Gemini ask for them (no fixed follow-up text here)
      setTimeout(()=>{
        const messageContent = `<svg class=\"bot-avatar\" xmlns=\"http://www.w3.org/2000/svg\" width=\"50\" height=\"50\" viewBox=\"0 0 1024 1024\"><path d=\"M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z\"/></svg><div class=\"message-text\"><div class=\"thinking-indicator\"><div class=\"dot\"></div><div class=\"dot\"></div><div class=\"dot\"></div></div></div>`;
        const incomingMessageDiv = createMessageElement(messageContent, 'bot-message', 'thinking');
        chatBody.appendChild(incomingMessageDiv);
        chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
        // Bias with any known context; otherwise Gemini will ask for specifics
        const firstName = cachedProfile && cachedProfile.fullName ? (String(cachedProfile.fullName).trim().split(' ')[0] || 'there') : 'there';
        const parts = [];
        if (helpTopic) parts.push(`HelpTopic: ${helpTopic}`);
        parts.push(`StudentFirstName: ${firstName}`);
        if (contextHelpType) parts.push(`HelpType: ${contextHelpType}`);
        if (contextSubject) parts.push(`Subject: ${contextSubject}`);
        userData.message = parts.join('\n');
        generateBotResponse(incomingMessageDiv);
      }, 600);
    }

    messageInput.addEventListener('input', ()=>{ messageInput.style.height = `${initialInputHeight}px`; messageInput.style.height = `${messageInput.scrollHeight}px`; root.querySelector('.chat-form').style.borderRadius = messageInput.scrollHeight > initialInputHeight ? '15px' : '32px'; });
    messageInput.addEventListener('keydown', (e)=>{ const userMessage = e.target.value.trim(); if (e.key==='Enter' && !e.shiftKey && userMessage && window.innerWidth > 768) { handleOutgoingMessage(e); } });

    if (fileInput) {
      fileInput.addEventListener('change', ()=>{ const file = fileInput.files[0]; if(!file) return; const reader = new FileReader(); reader.onload = (ev)=>{ try { if (fileUploadWrapper) { const img = fileUploadWrapper.querySelector('img'); if (img) img.src = ev.target.result; fileUploadWrapper.classList.add('file-uploaded'); } } catch{} fileInput.value=''; const b64 = String(ev.target.result).split(',')[1]; userData.file = { data: b64, mime_type: file.type }; }; reader.readAsDataURL(file); });
    }
    if (fileCancelButton && fileUploadWrapper) {
      fileCancelButton.addEventListener('click', ()=>{ userData.file = {}; try { fileUploadWrapper.classList.remove('file-uploaded'); } catch{} });
    }

    // Scroll-linked logo parallax: update CSS var based on scroll position
    chatBody.addEventListener('scroll', ()=>{
      const y = chatBody.scrollTop || 0;
      document.documentElement.style.setProperty('--tbp-chat-scroll', y + 'px');
    });

    function initEmoji(){
      if (!window.EmojiMart || !window.EmojiMart.Picker) { setTimeout(initEmoji, 100); return; }
      const picker = new EmojiMart.Picker({ theme:'light', skinTonePosition:'none', previewPosition:'none', onEmojiSelect: (emoji)=>{ const { selectionStart: start, selectionEnd: end } = messageInput; messageInput.setRangeText(emoji.native, start, end, 'end'); messageInput.focus(); }, onClickOutside: (e)=>{ if (e.target.id === 'emoji-picker') { document.body.classList.toggle('show-emoji-picker'); } else { document.body.classList.remove('show-emoji-picker'); } } });
      root.querySelector('.chat-form').appendChild(picker);
    }
    initEmoji();

    sendMessage.addEventListener('click', (e)=> handleOutgoingMessage(e));
    if (fileUploadButton && fileInput) {
      fileUploadButton.addEventListener('click', ()=> fileInput.click());
    }
    function resetChat(){
      // Clear transcript
      chatBody.innerHTML = '';
      const first = document.createElement('div');
      first.className = 'message bot-message';
      first.innerHTML = `<svg class=\"bot-avatar\" xmlns=\"http://www.w3.org/2000/svg\" width=\"50\" height=\"50\" viewBox=\"0 0 1024 1024\"><path d=\"M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z\"/> </svg><div class=\"message-text\"> Hey there 👋 <br /> How can I help you today? </div>`;
      chatBody.appendChild(first);
      // Reset seed
      chatHistory.length = 0;
      chatHistory.push({ role: 'model', parts: [{ text: SEED_PROMPT }] });
      loginPromptShown = false;
    }
    // When login completes via Open login link, refresh chat and ask for help topic first
    window.addEventListener('tbp:auth:login', async function(){
      // Only auto-open after login on timetable page
      try { if (!document.body.classList.contains('timetable')) return; } catch {}
      try {
        document.body.classList.add('show-chatbot');
        const profile = await getProfile();
        cachedProfile = profile; setAuthUI(!!profile);
        chatBody.innerHTML = '';
        const msg = createMessageElement(`<svg class=\"bot-avatar\" xmlns=\"http://www.w3.org/2000/svg\" width=\"50\" height=\"50\" viewBox=\"0 0 1024 1024\"><path d=\"M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z\"/></svg><div class=\"message-text\">You're logged in. What do you need help with? (e.g., Algebra homework, Chemistry quiz, due date)</div>`, 'bot-message');
        chatBody.appendChild(msg);
        chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
      } catch {}
    });
    async function initializeOnOpen(){
      try {
        const profile = await getProfile();
        cachedProfile = profile;
        chatBody.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'message bot-message';
        if (!profile) {
          msg.innerHTML = `<div class=\"message-text\">Please log in or sign up to continue scheduling. <a href=\"#\" class=\"open-login\">Open login</a></div>`;
        } else {
          const nm = (profile && profile.fullName ? String(profile.fullName).trim() : '') || '';
          const first = (nm.split(' ')[0] || nm || 'there');
          msg.innerHTML = `<svg class=\"bot-avatar\" xmlns=\"http://www.w3.org/2000/svg\" width=\"50\" height=\"50\" viewBox=\"0 0 1024 1024\"><path d=\"M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z\"/></svg><div class=\"message-text\">Hey ${first} 👋 How can I help?</div>`;
          hasAskedHelp = false; helpTopic = null; contextHelpType = null; contextSubject = null;
        }
        chatBody.appendChild(msg);
        // Wire open-login link to trigger login modal
        const link = msg.querySelector('.open-login');
        if (link) link.addEventListener('click', function(e){ e.preventDefault();
          try {
            const a = document.querySelector('.student-login-link');
            if (a) a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          } catch {}
        });
      } catch {}
    }
    // Expose for debugging
    window.tbpResetAI = resetChat;

    closeChatbot.addEventListener('click', ()=> { document.body.classList.remove('show-chatbot'); resetChat(); });
    function openChatAsync(){
      const willOpen = !document.body.classList.contains('show-chatbot');
      document.body.classList.add('show-chatbot');
      if (willOpen) {
        (async ()=>{
          try { const profile = await getProfile(); cachedProfile = profile; setAuthUI(!!profile); } catch { cachedProfile = null; setAuthUI(false); }
          try { await initializeOnOpen(); } catch {}
        })();
      }
    }

    if (chatbotToggler) chatbotToggler.addEventListener('click', ()=> { 
      const willOpen = !document.body.classList.contains('show-chatbot');
      document.body.classList.toggle('show-chatbot'); 
      if (willOpen) { 
        // Initialize without blocking UI open
        (async ()=>{
          try { const profile = await getProfile(); cachedProfile = profile; setAuthUI(!!profile); } catch { cachedProfile = null; setAuthUI(false); }
          try { await initializeOnOpen(); } catch {}
        })();
      }
    });

    // Global delegation: allow any element with these selectors to open chat
    document.addEventListener('click', function(e){
      const target = e.target.closest('#ai-chat-open, .floating-ai-btn, [data-open="schedule-ai"]');
      if (!target) return;
      e.preventDefault();
      openChatAsync();
    });

    // Public helper to open with assignment context from timetable
    window.tbpOpenScheduleAI = async function(assignmentTitle, dueIso){
      try {
        document.body.classList.add('show-chatbot');
        const profile = await getProfile();
        const raw = localStorage.getItem('tbp_user');
        let first = 'there';
        try {
          if (profile && profile.fullName) {
            const nm = String(profile.fullName).trim();
            first = (nm.split(' ')[0] || nm) || first;
          } else if (raw) {
            const u = JSON.parse(raw);
            const nm = (u && (u.fullName || u.email || '')).trim();
            if (nm) first = (nm.split(' ')[0] || nm.split('@')[0] || 'there');
          }
        } catch {}
        // If not logged in, instruct to sign up / log in and stop
        if (!profile) {
          try { chatBody.innerHTML = ''; } catch {}
          const msg = createMessageElement(`<div class=\"message-text\">Please log in or sign up to continue scheduling. <a href=\"#\" class=\"open-login\">Open login</a></div>`, 'bot-message');
          chatBody.appendChild(msg);
          const link = msg.querySelector('.open-login');
          if (link) link.addEventListener('click', function(e){ e.preventDefault();
            try {
              const a = document.querySelector('.student-login-link');
              if (a) a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            } catch {}
          });
          chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
          return;
        }

        const free = await fetchSessionsUntil(dueIso);
        const fmt = new Intl.DateTimeFormat('en-US',{ timeZone:'America/New_York', weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        const choices = free.slice(0,8).map(d=> fmt.format(d));

        if (choices.length > 0) {
          const suggestion = choices[0];
          const msg = createMessageElement(`<svg class=\"bot-avatar\" xmlns=\"http://www.w3.org/2000/svg\" width=\"50\" height=\"50\" viewBox=\"0 0 1024 1024\"><path d=\"M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z\"/></svg><div class=\"message-text\">Hi ${first}! I see that you need help on ${assignmentTitle}. How about ${suggestion}?</div>`, 'bot-message');
          chatBody.appendChild(msg);
          chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
        } else {
          const fallback = createMessageElement(`<svg class=\"bot-avatar\" xmlns=\"http://www.w3.org/2000/svg\" width=\"50\" height=\"50\" viewBox=\"0 0 1024 1024\"><path d=\"M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z\"/></svg><div class=\"message-text\">Help is on the way. Someone from our team will contact you through your email as soon as possible.</div>`, 'bot-message');
          chatBody.appendChild(fallback);
          chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
          if (window.tbpFallbackNotify) try { await window.tbpFallbackNotify(); } catch {}
        }
      } catch {}
    };

    // Warn if missing API key
    if (API_KEY === API_KEY_PLACEHOLDER && !window.TBP_GEMINI_API_KEY) {
      console.warn('Gemini API key missing. Set window.TBP_GEMINI_API_KEY = "<key>" to enable responses.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    // DOM is already ready (script loaded late) – mount immediately
    try { mount(); } catch {}
  }
})();


