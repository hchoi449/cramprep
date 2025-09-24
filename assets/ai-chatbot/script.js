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
      overlay.addEventListener('click', ()=> {
        document.body.classList.remove('show-chatbot');
        try { if (typeof window.tbpResetAI === 'function') window.tbpResetAI(); } catch {}
        try { window.__tbp_hasGreeted = false; } catch {}
        try { window.__tbp_clearOnNextOpen = true; } catch {}
      });
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

    // API via server proxy (no client-side key exposure)
    const AUTH_BASE = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
    const API_URL = `${AUTH_BASE}/ai/generate`;

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
    let preferredDay = null; // 0-6 (Sun-Sat)
    let dueDateIso = null;   // ISO string if parsed

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

    function categorizeEventTitle(title){
      const t = String(title||'').toLowerCase();
      if (/\b(exams?|tests?|assessments?|quiz(?:zes)?)\b/.test(t)) return 'exam';
      return 'homework';
    }

    async function fetchSessionsUntil(deadlineIso, desiredType, strictType){
      try {
        const AUTH_BASE = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
        const res = await fetch(`${AUTH_BASE}/sessions`, { headers: { Accept:'application/json' } });
        if (!res.ok) return [];
        const j = await res.json();
        const events = (j && j.events) ? j.events : [];
        const now = new Date();
        let deadline = deadlineIso ? new Date(deadlineIso) : new Date(now.getTime() + 7*86400000);
        // If a due date is provided, treat the deadline as the end of that calendar day
        if (deadlineIso) { const end = new Date(deadline); end.setHours(23,59,59,999); deadline = end; }
        const base = events
          .map(ev => ({
            start: new Date(ev.start),
            end: new Date(ev.end),
            title: ev.title,
            type: (ev.type ? String(ev.type).toLowerCase() : categorizeEventTitle(ev.title))
          }))
          .filter(ev => ev.start >= now && ev.start <= deadline)
          .sort((a,b)=> a.start - b.start);
        if (!desiredType) return base;
        const typed = base.filter(ev => ev.type === desiredType);
        if (strictType) return typed; // do not fall back when strict
        return typed.length ? typed : base; // otherwise fall back to any session if none match
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
      const div = createMessageElement(`<div class=\"message-text\">Please log in or sign up to continue scheduling.<br><button class=\"btn btn-secondary btn-chat open-login-btn\" aria-label=\"Open login\">Open login</button></div>`, 'bot-message');
      chatBody.appendChild(div);
      const btnOpen = div.querySelector('.open-login-btn');
      if (btnOpen) btnOpen.addEventListener('click', function(e){ e.preventDefault();
        try { document.body.classList.remove('show-chatbot'); } catch {}
        try {
          const a = document.querySelector('.student-login-link');
          if (a) a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch {}
      });
      chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
      loginPromptShown = true;
    }

    async function generateBotResponse(incomingMessageDiv){
      chatHistory.push({ role:'user', parts:[{ text: userData.message }, ...(userData.file.data ? [{ inline_data: userData.file }] : [])] });
      try { /* scheduling mode uses custom flows below; still call Gemini for free-form */ } catch {}
      const requestOptions = { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ model:'openai:gpt-4o-mini', contents: chatHistory, generationConfig: { temperature: 0.3, topP: 0.8, candidateCount: 1 } }) };
      try {
        const response = await fetch(API_URL, requestOptions);
        const data = await response.json();
        if (!response.ok) throw new Error((data && data.error && data.error.message) || 'API error');
        const apiResponseText = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text || '').replace(/\*\*(.*?)\*\*/g,'$1').trim();
        const constrained = apiResponseText ? apiResponseText.slice(0, 300) : '';
        const messageElement = incomingMessageDiv.querySelector('.message-text');
        messageElement.innerText = constrained || '...';
        chatHistory.push({ role:'model', parts:[{ text: constrained }] });
        // If model signals fallback, trigger notify
        if (/no available session at this time/i.test(constrained) || /contact you through text shortly/i.test(constrained)) {
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
    function detectPreferredDay(text){
      if (!text) return null;
      const t = String(text).toLowerCase();
      const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      for (let i=0;i<7;i++){ if (new RegExp(`\\b${days[i]}\\b`).test(t)) return i; }
      return null;
    }
    function detectDueDate(text){
      if (!text) return null;
      const t = String(text).toLowerCase();
      const m = t.match(/due\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
      if (m){
        const idx = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(m[1]);
        if (idx>=0){
          const now = new Date();
          const d = new Date(now);
          let delta = (idx - now.getDay() + 7) % 7; if (delta===0) delta=7;
          d.setDate(now.getDate() + delta); d.setHours(23,59,59,999);
          return d.toISOString();
        }
      }
      return null;
    }

    // Parse time-of-day like "4pm", "4 pm", "16:00", "4:30pm" → {hour, minute}
    function parseTimeOfDay(text){
      if (!text) return null;
      const t = String(text).toLowerCase();
      let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
      if (m) {
        let h = parseInt(m[1],10);
        const min = m[2] ? parseInt(m[2],10) : 0;
        const ap = m[3];
        if (ap === 'pm' && h !== 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return { hour: h, minute: min };
      }
      m = t.match(/\b(\d{1,2}):(\d{2})\b/);
      if (m) {
        const h = parseInt(m[1],10);
        const min = parseInt(m[2],10);
        if (h>=0 && h<=23 && min>=0 && min<=59) return { hour: h, minute: min };
      }
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
      const messageContent = `<div class="message-text"></div>${userData.file.data ? `<img src="data:${userData.file.mime_type};base64,${userData.file.data}" class="attachment" />` : ''}`;
      const outgoingMessageDiv = createMessageElement(messageContent, 'user-message');
      outgoingMessageDiv.querySelector('.message-text').innerText = userData.message;
      chatBody.appendChild(outgoingMessageDiv);
      chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });

      // Detect "these times don't work" intent and short-circuit with custom message
      try {
        const msg = userData.message.toLowerCase();
        const negative = /(don'?t|do not|won'?t|cannot|can\'t|no|not)/i;
        const timePhrases = /(time|times|option|options|slot|slots|schedule|availability|these\s+times|those\s+times)/i;
        const pronounPhrases = /(it|that|this|they|them|those|these|that\s+one|this\s+one|that\s+time|this\s+time)/i;
        const notWorkPhrases = /(don'?t work|do not work|won'?t work|not work|don'?t fit|do not fit|don'?t match|do not match|can'?t make|can not make|don'?t have|none work|none of these|none of them|don'?t\s*(really)?\s*work\s*(for\s*me)?|won'?t\s*do)/i;
        const mixedTime = (new RegExp(`(${negative.source}).*(${timePhrases.source})`,'i').test(msg)) || (new RegExp(`(${timePhrases.source}).*(${negative.source})`,'i').test(msg));
        const mixedPronoun = (new RegExp(`(${negative.source}).*(${pronounPhrases.source})`,'i').test(msg)) || (new RegExp(`(${pronounPhrases.source}).*(${negative.source})`,'i').test(msg));
        if (mixedTime || mixedPronoun || notWorkPhrases.test(msg)) {
          const tod = parseTimeOfDay(userData.message);
          // Try to propose alternatives near the requested time and day/type if available
          try {
            const desiredType = contextHelpType;
            const pool = await fetchSessionsUntil(dueDateIso, desiredType, false);
            let candidates = pool;
            if (preferredDay !== null) candidates = candidates.filter(ev => ev.start.getDay() === preferredDay);
            if (tod) {
              // Find sessions within +-3 hours of the requested time-of-day
              candidates = candidates.filter(ev => {
                const evH = ev.start.getHours();
                const evM = ev.start.getMinutes();
                const deltaMin = Math.abs((evH*60+evM) - (tod.hour*60 + tod.minute));
                return deltaMin <= 180; // 3 hours window
              });
            }
            if (candidates && candidates.length) {
              const fmtDate = new Intl.DateTimeFormat('en-US',{ timeZone:'America/New_York', weekday:'short', month:'short', day:'numeric' });
              const fmtTime = new Intl.DateTimeFormat('en-US',{ timeZone:'America/New_York', hour:'numeric', minute:'2-digit' });
              const rows = candidates.slice(0,5).map((ev,i)=>{
                const dateStr = fmtDate.format(ev.start);
                const timeStr = `${fmtTime.format(ev.start)} – ${fmtTime.format(ev.end)} (EST)`;
                const titleStr = ev.title || (ev.type==='exam' ? 'Exam Prep Session' : 'Homework Prep Session');
                return `<tr><td>${titleStr}</td><td>${dateStr}</td><td>${timeStr}</td><td><button class="btn btn-primary btn-sm register-session" data-idx="${i}">Register</button></td></tr>`;
              }).join('');
              const table = createMessageElement(`<svg class="bot-avatar" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z"/></svg><div class="message-text">Here are some alternatives around your time:<br><table class="ai-table"><thead><tr><th>Session</th><th>Date</th><th>Time</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`, 'bot-message');
              chatBody.appendChild(table);
              chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
              // Wire register buttons
              table.querySelectorAll('.register-session').forEach(btn=>{
                btn.addEventListener('click', function(){
                  try { if (window.tbpOpenEnroll) window.tbpOpenEnroll(); else document.querySelector('.floating-consult-btn')?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); } catch {}
                });
              });
              return;
            }
          } catch {}
          const nm = (cachedProfile && cachedProfile.fullName ? String(cachedProfile.fullName).trim() : '') || '';
          const first = (nm.split(' ')[0] || nm || 'there');
          const reply = createMessageElement(`<svg class="bot-avatar" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z"/></svg><div class="message-text">Got it. Thanks ${first}. Someone will contact you through text shortly. Is there anything else I can help with?</div>`, 'bot-message');
          chatBody.appendChild(reply);
          chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
          if (window.tbpFallbackNotify) {
            try { await window.tbpFallbackNotify(); } catch {}
          } else {
            // Fallback submit if helper not present
            try {
              const raw = localStorage.getItem('tbp_user');
              const user = raw ? JSON.parse(raw) : {};
              const studentName = (cachedProfile && cachedProfile.fullName) ? cachedProfile.fullName : (user && (user.fullName || user.email || 'Unknown'));
              const due = (typeof dueDateIso === 'string' && dueDateIso) ? new Intl.DateTimeFormat('en-US',{ month:'short', day:'numeric', year:'numeric' }).format(new Date(dueDateIso)) : 'Unknown';
              const payload = { name: studentName, assignment: helpTopic || 'Unknown', dueDate: due };
              await fetch('https://formspree.io/f/mvgbnkgn', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
            } catch {}
          }
          return;
        }
      } catch {}

      // If we've asked for help topic and none captured yet, intercept greetings/short replies
      if (hasAskedHelp && !helpTopic) {
        const looksGreeting = /^(hi|hey|hello|yo|sup|good\s*(morning|afternoon|evening))\b/i.test(userData.message);
        const hasKeywords = /(homework|exam|test|quiz|assessment|assignment|project|paper|lab|due|study|help)\b/i.test(userData.message);
        if (!hasKeywords && (looksGreeting || userData.message.length < 15)) {
          const ask = createMessageElement(`<div class="message-text">Got it. What do you need help with? (e.g., Algebra homework due Thu)</div>`, 'bot-message');
          chatBody.appendChild(ask);
          chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
          return;
        }
        helpTopic = userData.message;
      }

      // Extract structured context from any message
      const ht = detectHelpType(userData.message); if (ht && !contextHelpType) contextHelpType = ht;
      const sj = detectSubject(userData.message); if (sj && !contextSubject) contextSubject = sj;
      const pd = detectPreferredDay(userData.message); if (pd !== null) preferredDay = pd;
      const due = detectDueDate(userData.message); if (due) dueDateIso = due;
      // If message looks like a new request (contains assignment signals or is descriptive), capture as new assignment title
      {
        const looksGreeting = /^(hi|hey|hello|yo|sup|good\s*(morning|afternoon|evening))\b/i.test(userData.message);
        const hasSignal = !!(ht || sj || pd !== null || due) || /assignment|homework|quiz|exam|test|project|paper|lab|due/i.test(userData.message);
        if (!looksGreeting && (hasSignal || userData.message.length >= 12)) {
          helpTopic = userData.message.trim();
        }
      }
      // If missing details, let Gemini ask for them (no fixed follow-up text here)
      setTimeout(()=>{
        const messageContent = `<svg class="bot-avatar" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z"/></svg><div class="message-text"><div class="thinking-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`;
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
      // Reset seed
      chatHistory.length = 0;
      chatHistory.push({ role: 'model', parts: [{ text: SEED_PROMPT }] });
      loginPromptShown = false;
    }
    // On login, update cached profile and mark to refresh on next open
    window.addEventListener('tbp:auth:login', async function(){
      try { const profile = await getProfile(); cachedProfile = profile; setAuthUI(!!profile); } catch {}
      try { window.__tbp_clearOnNextOpen = true; } catch {}
    });
    async function initializeOnOpen(){
      try {
        const profile = await getProfile();
        cachedProfile = profile;
        chatBody.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'message bot-message';
        if (!profile) {
          msg.innerHTML = `<div class=\"message-text\">Please log in or sign up to continue scheduling.<br><button class=\"btn btn-secondary btn-chat open-login-btn\" aria-label=\"Open login\">Open login</button></div>`;
        } else {
          const nm = (profile && profile.fullName ? String(profile.fullName).trim() : '') || '';
          const first = (nm.split(' ')[0] || nm || 'there');
          if (!window.__tbp_hasGreeted) {
            msg.innerHTML = `<svg class=\"bot-avatar\" xmlns=\"http://www.w3.org/2000/svg\" width=\"50\" height=\"50\" viewBox=\"0 0 1024 1024\"><path d=\"M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z\"/></svg><div class=\"message-text\">Hey ${first} 👋 How can I help you schedule?</div>`;
            window.__tbp_hasGreeted = true;
          } else {
            msg.innerHTML = `<svg class=\"bot-avatar\" xmlns=\"http://www.w3.org/2000/svg\" width=\"50\" height=\"50\" viewBox=\"0 0 1024 1024\"><path d=\"M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z\"/></svg><div class=\"message-text\">How can I help you schedule?</div>`;
          }
        }
        chatBody.appendChild(msg);
        // Wire open-login link to trigger login modal
        const loginBtn = msg.querySelector('.open-login-btn');
        if (loginBtn) loginBtn.addEventListener('click', function(e){ e.preventDefault();
          try { document.body.classList.remove('show-chatbot'); } catch {}
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
    // Clear on outside click already handled on overlay; also clear on Escape
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') {
        try { document.body.classList.remove('show-chatbot'); resetChat(); } catch{}
        try { const modal = document.querySelector('.modal.active'); if (modal) modal.classList.remove('active'); } catch{}
        try { const drawer = document.getElementById('assignments-drawer'); if (drawer) { drawer.classList.remove('active'); drawer.setAttribute('aria-hidden','true'); } } catch{}
        try { const tab = document.getElementById('assignments-tab'); if (tab) tab.setAttribute('aria-expanded','false'); } catch{}
      }
    });
    function openChatAsync(){
      const willOpen = !document.body.classList.contains('show-chatbot');
      document.body.classList.add('show-chatbot');
      if (willOpen) {
        (async ()=>{
          try { const profile = await getProfile(); cachedProfile = profile; setAuthUI(!!profile); } catch { cachedProfile = null; setAuthUI(false); }
          try {
            const hasHistory = !!(chatBody && chatBody.children && chatBody.children.length > 0);
            const hasLoginPrompt = hasHistory && /Please log in or sign up/i.test(chatBody.textContent||'');
            if (hasLoginPrompt || window.__tbp_clearOnNextOpen) {
              chatBody.innerHTML = '';
              await initializeOnOpen();
              window.__tbp_clearOnNextOpen = false;
            } else if (!hasHistory) {
              await initializeOnOpen();
            }
          } catch {}
        })();
      }
    }

    if (chatbotToggler) chatbotToggler.addEventListener('click', ()=> { 
      const willOpen = !document.body.classList.contains('show-chatbot');
      document.body.classList.toggle('show-chatbot'); 
      if (willOpen) { 
        // Initialize without clearing existing transcript unless it was a login prompt
        (async ()=>{
          try { const profile = await getProfile(); cachedProfile = profile; setAuthUI(!!profile); } catch { cachedProfile = null; setAuthUI(false); }
          try {
            const hasHistory = !!(chatBody && chatBody.children && chatBody.children.length > 0);
            const hasLoginPrompt = hasHistory && /Please log in or sign up/i.test(chatBody.textContent||'');
            if (hasLoginPrompt || window.__tbp_clearOnNextOpen) {
              chatBody.innerHTML = '';
              await initializeOnOpen();
              window.__tbp_clearOnNextOpen = false;
            } else if (!hasHistory) {
              await initializeOnOpen();
            }
          } catch {}
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
    window.tbpOpenScheduleAI = async function(assignmentTitle, dueIso, helpType){
      try {
        document.body.classList.add('show-chatbot');
        const profile = await getProfile();
        const raw = localStorage.getItem('tbp_user');
        // If chat still shows a stale login prompt but the user is now authenticated, clear it
        try {
          if (profile) {
            const hasLoginPrompt = /Please log in or sign up/i.test(chatBody.textContent||'');
            if (hasLoginPrompt) {
              chatBody.innerHTML = '';
              loginPromptShown = false;
            }
          }
        } catch {}
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
          const msg = createMessageElement(`<div class="message-text">Please log in or sign up to continue scheduling. <a href="#" class="open-login">Open login</a></div>`, 'bot-message');
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

        const list = await fetchSessionsUntil(dueIso, helpType, true);
        // Always show thinking dots before any bot message
        const thinkingContent = `<svg class="bot-avatar" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z"/></svg><div class="message-text"><div class="thinking-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`;
        const thinkingDiv = createMessageElement(thinkingContent, 'bot-message', 'thinking');
        chatBody.appendChild(thinkingDiv);
        chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
        if (list.length > 0) {
          const fmtDate = new Intl.DateTimeFormat('en-US',{ timeZone:'America/New_York', weekday:'short', month:'short', day:'numeric' });
          const fmtTime = new Intl.DateTimeFormat('en-US',{ timeZone:'America/New_York', hour:'numeric', minute:'2-digit' });
          const headerText = `I see that you need help with ${assignmentTitle}. Here are the available ${(helpType||'session')} times:`;
          const rows = list.slice(0,5).map((ev,i)=>{
            const dateStr = fmtDate.format(ev.start);
            const timeStr = `${fmtTime.format(ev.start)} – ${fmtTime.format(ev.end)} (EST)`;
            const titleStr = ev.title || (ev.type==='exam' ? 'Exam Prep Session' : 'Homework Prep Session');
            return `<tr><td>${titleStr}</td><td>${dateStr}</td><td>${timeStr}</td><td><button class="btn btn-primary btn-sm register-session" data-idx="${i}">Register</button></td></tr>`;
          }).join('');
          const html = `${headerText}<br><table class="ai-table"><thead><tr><th>Session</th><th>Date</th><th>Time</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
          // Replace thinking with the table message
          try { thinkingDiv.querySelector('.message-text').innerHTML = html; thinkingDiv.classList.remove('thinking'); } catch { }
          const msg = thinkingDiv;
          window.__tbp_hasGreeted = true;
          // Wire register buttons
          msg.querySelectorAll('.register-session').forEach(btn=>{
            btn.addEventListener('click', function(){
              try { if (window.tbpOpenEnroll) window.tbpOpenEnroll(); else document.querySelector('.floating-consult-btn')?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); } catch {}
            });
          });
          // Follow-up message with Contact us button
          const followThinking = createMessageElement(thinkingContent, 'bot-message', 'thinking');
          chatBody.appendChild(followThinking);
          chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
          const follow = followThinking;
          try { follow.querySelector('.message-text').innerHTML = `Let me know if these times don’t work.<br><button class="btn btn-secondary btn-chat contact-us" aria-label="Contact us for scheduling help">Contact us</button>`; follow.classList.remove('thinking'); } catch {}
          // Local fallback sender using current context
          async function sendFallbackNow(){
            try {
              const raw = localStorage.getItem('tbp_user');
              const user = raw ? JSON.parse(raw) : {};
              const studentName = (profile && profile.fullName) ? profile.fullName : (user && (user.fullName || user.email || 'Unknown'));
              const due = dueIso ? new Intl.DateTimeFormat('en-US',{ month:'short', day:'numeric', year:'numeric' }).format(new Date(dueIso)) : 'Unknown';
              const payload = { name: studentName, assignment: assignmentTitle || 'Unknown', dueDate: due };
              await fetch('https://formspree.io/f/mvgbnkgn', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
            } catch {}
          }
          const btn = follow.querySelector('.contact-us');
          if (btn) btn.addEventListener('click', async function(){
            const ack = createMessageElement(`<svg class="bot-avatar" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z"/></svg><div class="message-text">Someone will contact you shortly to help with scheduling.</div>`, 'bot-message');
            chatBody.appendChild(ack);
            chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });
            if (window.tbpFallbackNotify) { try { await window.tbpFallbackNotify(); } catch {} } else { await sendFallbackNow(); }
          });
        } else {
          // Replace thinking with fallback message
          // If due today (local EST) or past due, show past-due specific message
          let showPastDue = false;
          try {
            if (dueIso) {
              const tz = 'America/New_York';
              const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
              const todayYmd = ymdFmt.format(new Date());
              const dueYmd = ymdFmt.format(new Date(dueIso));
              showPastDue = (dueYmd <= todayYmd);
            }
          } catch {}
          const text = showPastDue
            ? `I see that the ${assignmentTitle} is past due. Someone will be in touch to assist you in scheduling.`
            : `It seems that there is no available session at this time for ${assignmentTitle}. Someone from our team will contact you to help with scheduling as soon as possible.`;
          try { thinkingDiv.querySelector('.message-text').innerHTML = text; thinkingDiv.classList.remove('thinking'); } catch {}
          if (window.tbpFallbackNotify) try { await window.tbpFallbackNotify(); } catch {}
        }
      } catch {}
    };

    // No key needed on client; server handles provider keys
  }

  if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
  } else {
    // DOM is already ready (script loaded late) – mount immediately
    try { mount(); } catch {}
  }
})();


