/* Study AI - isolated chatbot (separate from Schedule AI)
 * Mounts its own UI and uses the server proxy /ai/generate.
 * Open with any element having [data-open="study-ai"].
 */
(function(){
  // Load Material Symbols (same as Schedule AI)
  const iconHref = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0&family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@48,400,1,0';
  if (!document.querySelector(`link[href^="${iconHref}"]`)) {
    const lf = document.createElement('link'); lf.rel='stylesheet'; lf.href=iconHref; document.head.appendChild(lf);
  }
  // Build root UI (reuses existing CSS class names for styling, but scoped to this root)
  const root = document.createElement('div');
  root.className = 'study-chatbot-root';
  root.style.display = 'none';
  root.style.position = 'fixed';
  root.style.left = '50%';
  root.style.top = '50%';
  root.style.transform = 'translate(-50%, -50%)';
  root.style.zIndex = '1300';
  // Do not inject fallback CSS; page should load /assets/ai-chatbot/style.css for parity
  root.innerHTML = `
  <div class="chatbot-popup">
          <div class="chat-header" style="cursor:move">
            <div class="header-info" style="display:flex;align-items:center;gap:10px">
              <svg class="chatbot-logo" xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 1024 1024" style="padding:6px;fill:#8B4513;background:#fff;border-radius:50%"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9zM351.7 448.2c0-29.5 23.9-53.5 53.5-53.5s53.5 23.9 53.5 53.5-23.9 53.5-53.5 53.5-53.5-23.9-53.5-53.5zm157.9 267.1c-67.8 0-123.8-47.5-132.3-109h264.6c-8.6 61.5-64.5 109-132.3 109zm110-213.7c-29.5 0-53.5-23.9-53.5-53.5s23.9-53.5 53.5-53.5 53.5 23.9 53.5 53.5-23.9 53.5-53.5 53.5z"/></svg>
              <h2 class="logo-text" style="color:#fff;font-weight:600;font-size:1.1rem;letter-spacing:.02rem">Chatbot</h2>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <button id="close-chatbot" class="material-symbols-rounded" style="color:#fff">✕</button>
            </div>
          </div>
    <div class="chat-body"></div>
    <div class="chat-footer">
      <form action="#" class="chat-form">
        <textarea placeholder="Ask about your homework..." class="message-input" required></textarea>
        <div class="file-upload-wrapper" style="display:none">
          <img alt="preview" />
          <button type="button" id="study-file-cancel">×</button>
        </div>
        <input id="study-file-input" type="file" accept="image/*,application/pdf" style="display:none" />
        <div class="chat-controls">
          <button type="button" id="study-file-upload" class="material-symbols-rounded" style="display:none">attach_file</button>
        </div>
      </form>
    </div>
  </div>`;
  document.body.appendChild(root);
  // Revert: prevent resizing (no expand/minimize)
  try {
    const popup = root.querySelector('.chatbot-popup');
    if (popup){ popup.style.resize = 'none'; popup.style.overflow = 'hidden'; }
    const st = document.getElementById('study-resize-style');
    if (st) st.remove();
  } catch{}

  // Remove any custom Study AI watermark override; fall back to default icon from shared CSS
  try { const s = document.getElementById('study-ai-theme'); if (s) s.remove(); } catch {}

  // Overlay to close on outside click (reuse schedule overlay class for identical style)
  let overlay = document.querySelector('.tbp-chat-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'tbp-chat-overlay';
    document.body.appendChild(overlay);
  }

  const chatBody = root.querySelector('.chat-body');
  const messageInput = root.querySelector('.message-input');
  const sendMessage = null; // No arrow button; Enter-to-send only
  const fileInput = root.querySelector('#study-file-input');
  const fileUploadWrapper = root.querySelector('.file-upload-wrapper');
  const fileCancelButton = root.querySelector('#study-file-cancel');
  const closeChatbot = root.querySelector('#close-chatbot');

  // API setup (server proxy, no client key)
  const AUTH_BASE = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/, '') : '';
  const API_URL = `${AUTH_BASE}/ai/generate`;

// Initialize user message and file data
const userData = {
  message: null,
  file: {
    data: null,
    mime_type: null,
  },
};

// Store chat history
const chatHistory = [];
// Seed: Study AI for middle/high schoolers. Follow the coaching flow strictly.
const SEED_PROMPT = "You are Study AI, a friendly tutor for middle/high school math and science. Always teach using this flow: 1) Start with a simple, relatable analogy or hook that makes the idea intuitive. 2) Break the problem into short, numbered steps with hints (do NOT give the full answer outright). 3) After each step, ask ONE guiding question and pause so the student can try. 4) When the student replies, begin with immediate feedback (praise if correct, gentle correction if not) and then move to the next hint. 5) Use quick visuals with plain text where helpful (e.g., factor trees, number lines, balance-scale equations). 6) End each mini-lesson with a quick recap and offer one harder practice problem. Keep messages concise, supportive, and age-appropriate. Avoid revealing the final answer unless the student specifically asks; prefer hints and checks. Avoid LaTeX; use plain text/ASCII for visuals.";
chatHistory.push({ role: "model", parts: [{ text: SEED_PROMPT }] });
const initialInputHeight = messageInput.scrollHeight;

// Create message element with dynamic classes and return it
const createMessageElement = (content, ...classes) => {
  const div = document.createElement("div");
  div.classList.add("message", ...classes);
  div.innerHTML = content;
  return div;
};

// Generate bot response using API
const generateBotResponse = async (incomingMessageDiv) => {
  const messageElement = incomingMessageDiv.querySelector(".message-text");

  // Add user message to chat history
  chatHistory.push({
    role: "user",
    parts: [{ text: userData.message }, ...(userData.file.data ? [{ inline_data: userData.file }] : [])],
  });

  // API request options (server proxy expects: { model, contents, generationConfig })
  const requestOptions = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai:gpt-4o-mini",
      contents: chatHistory,
      generationConfig: { temperature: 0.3, topP: 0.8, candidateCount: 1 },
    }),
  };

  try {
    // Fetch bot response from API
    const response = await fetch(API_URL, requestOptions);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error.message);

    // Extract and display bot's response text
    let apiResponseText = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || "";
    apiResponseText = apiResponseText.replace(/\*\*(.*?)\*\*/g, "$1").trim();

    // Guardrails: refuse to state the final answer explicitly
    const directAsk = /\b(answer|final|give me|what is|solve for|which option)\b.*\b(is|=)\b/i.test(userData.message||"");
    const looksExplicit = /\b(final answer|the answer is|correct option is|equals\s*[^\s]+|=\s*[^\s]+)\b/i.test(apiResponseText);
    if (directAsk || looksExplicit) {
      apiResponseText += "\n\nI won't state the final answer. Try the last step and tell me what you get—I'm happy to check your work.";
    }
    messageElement.innerText = apiResponseText;

    // Add bot response to chat history
    chatHistory.push({
      role: "model",
      parts: [{ text: apiResponseText }],
    });
  } catch (error) {
    // Handle error in API response
    console.log(error);
    messageElement.innerText = error.message;
    messageElement.style.color = "#ff0000";
  } finally {
    // Reset user's file data, removing thinking indicator and scroll chat to bottom
    userData.file = {};
    incomingMessageDiv.classList.remove("thinking");
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
  }
};

// Handle outgoing user messages
const handleOutgoingMessage = (e) => {
  e.preventDefault();
  userData.message = messageInput.value.trim();
  messageInput.value = "";
  messageInput.dispatchEvent(new Event("input"));
  fileUploadWrapper.classList.remove("file-uploaded");

  // Create and display user message
  const messageContent = `<div class="message-text"></div>
                          ${userData.file.data ? `<img src="data:${userData.file.mime_type};base64,${userData.file.data}" class="attachment" />` : ""}`;

  const outgoingMessageDiv = createMessageElement(messageContent, "user-message");
  outgoingMessageDiv.querySelector(".message-text").innerText = userData.message;
  chatBody.appendChild(outgoingMessageDiv);
  chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });

  // Simulate bot response with thinking indicator after a delay
  setTimeout(() => {
    const messageContent = `<svg class="bot-avatar" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024">
            <path
              d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9zM351.7 448.2c0-29.5 23.9-53.5 53.5-53.5s53.5 23.9 53.5 53.5-23.9 53.5-53.5 53.5-53.5-23.9-53.5-53.5zm157.9 267.1c-67.8 0-123.8-47.5-132.3-109h264.6c-8.6 61.5-64.5 109-132.3 109zm110-213.7c-29.5 0-53.5-23.9-53.5-53.5s23.9-53.5 53.5-53.5 53.5 23.9 53.5 53.5-23.9 53.5-53.5 53.5zM867.2 644.5V453.1h26.5c19.4 0 35.1 15.7 35.1 35.1v121.1c0 19.4-15.7 35.1-35.1 35.1h-26.5zM95.2 609.4V488.2c0-19.4 15.7-35.1 35.1-35.1h26.5v191.3h-26.5c-19.4 0-35.1-15.7-35.1-35.1zM561.5 149.6c0 23.4-15.6 43.3-36.9 49.7v44.9h-30v-44.9c-21.4-6.5-36.9-26.3-36.9-49.7 0-28.6 23.3-51.9 51.9-51.9s51.9 23.3 51.9 51.9z"/></svg>
          <div class="message-text">
            <div class="thinking-indicator">
              <div class="dot"></div>
              <div class="dot"></div>
              <div class="dot"></div>
            </div>
          </div>`;

    const incomingMessageDiv = createMessageElement(messageContent, "bot-message", "thinking");
    chatBody.appendChild(incomingMessageDiv);
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
    generateBotResponse(incomingMessageDiv);
  }, 600);
};

// Adjust input field height dynamically
messageInput.addEventListener("input", () => {
  messageInput.style.height = `${initialInputHeight}px`;
  messageInput.style.height = `${messageInput.scrollHeight}px`;
  root.querySelector(".chat-form").style.borderRadius = messageInput.scrollHeight > initialInputHeight ? "15px" : "32px";
});

// Handle Enter key press for sending messages
messageInput.addEventListener("keydown", (e) => {
  const userMessage = e.target.value.trim();
  if (e.key === "Enter" && !e.shiftKey && userMessage && window.innerWidth > 768) {
    handleOutgoingMessage(e);
  }
});

// Handle file input change and preview the selected file
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    fileInput.value = "";
    fileUploadWrapper.querySelector("img").src = e.target.result;
    fileUploadWrapper.classList.add("file-uploaded");
    const base64String = e.target.result.split(",")[1];

    // Store file data in userData
    userData.file = {
      data: base64String,
      mime_type: file.type,
    };
  };

  reader.readAsDataURL(file);
});

// Cancel file upload
if (fileCancelButton) fileCancelButton.addEventListener("click", () => {
  userData.file = {};
  fileUploadWrapper.classList.remove("file-uploaded");
});

// EmojiMart no longer used; keeping minimal spacing adjustment only

// No explicit send button; users press Enter to send
const fileUploadBtn = root.querySelector("#study-file-upload");
if (fileUploadBtn) fileUploadBtn.addEventListener("click", () => fileInput.click());
  closeChatbot.addEventListener("click", () => { root.style.display='none'; overlay.style.display='none'; try{ document.body.classList.remove('show-chatbot'); }catch{} });
  // Make Study AI draggable by header
  try {
    const header = root.querySelector('.chat-header');
    if (header) header.style.cursor = 'move';
    let startX=0, startY=0, startLeft=0, startTop=0, dragging=false;
    function onDown(e){ dragging=true; const r = root.getBoundingClientRect(); startX=e.clientX; startY=e.clientY; startLeft=r.left; startTop=r.top; root.style.transform='translate(0,0)'; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); }
    function onMove(e){ if(!dragging) return; const dx=e.clientX-startX, dy=e.clientY-startY; const w=root.offsetWidth, h=root.offsetHeight; const nx=Math.max(8, Math.min(window.innerWidth-w-8, startLeft+dx)); const ny=Math.max(8, Math.min(window.innerHeight-h-8, startTop+dy)); root.style.left=nx+'px'; root.style.top=ny+'px'; }
    function onUp(){ dragging=false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    if (header) header.addEventListener('mousedown', onDown);
  } catch {}

  // Removed explicit expand button; resizing is available via edges/corner

// Open Study AI via data-open="study-ai"
document.addEventListener('click', function(e){
  const target = e.target.closest('[data-open="study-ai"]');
  if (!target) return;
  e.preventDefault();
  // Ensure DOM is attached before showing
  if (!document.body.contains(root)) document.body.appendChild(root);
  root.style.display = 'block';
  overlay.style.display = 'block';
  try { document.body.classList.add('show-chatbot'); } catch {}
  try {
    // Default greeting when opening Study AI
    if (!chatBody.children.length) {
      const msg = document.createElement('div');
      msg.className = 'message bot-message';
      msg.innerHTML = `<svg class="bot-avatar" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z"/></svg><div class="message-text">Hi! I'm your Study AI. Tell me what problems you're working on and I'll explain, outline steps, and give hints.</div>`;
      chatBody.appendChild(msg);
    }
  } catch {}
  try { messageInput.focus(); } catch {}
});

overlay.addEventListener('click', ()=> { root.style.display='none'; overlay.style.display='none'; try{ document.body.classList.remove('show-chatbot'); }catch{} });
})();
