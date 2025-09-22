const chatBody = document.querySelector(".chat-body");
const messageInput = document.querySelector(".message-input");
const sendMessage = document.querySelector("#send-message");
const fileInput = document.querySelector("#file-input");
const fileUploadWrapper = document.querySelector(".file-upload-wrapper");
const fileCancelButton = fileUploadWrapper.querySelector("#file-cancel");
const chatbotToggler = document.querySelector("#chatbot-toggler");
const closeChatbot = document.querySelector("#close-chatbot");

/* Study AI - isolated chatbot (separate from Schedule AI)
 * Mounts its own UI and uses the server proxy /ai/generate.
 * Open with any element having [data-open="study-ai"].
 */
(function(){
  // Build root UI (reuses existing CSS class names for styling, but scoped to this root)
  const root = document.createElement('div');
  root.className = 'study-chatbot-root';
  root.style.display = 'none';
  root.innerHTML = `
  <div class="chatbot-popup">
    <div class="chat-header">
      <div class="header-info">
        <svg class="chatbot-logo" xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 1024 1024"><path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 47.8 106.8 106.8 106.8h81.5v111.1c0 .7.8 1.1 1.4.7l166.9-110.6 41.8-.8h117.4l43.6-.4c59 0 106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9zM351.7 448.2c0-29.5 23.9-53.5 53.5-53.5s53.5 23.9 53.5 53.5-23.9 53.5-53.5 53.5-53.5-23.9-53.5-53.5zm157.9 267.1c-67.8 0-123.8-47.5-132.3-109h264.6c-8.6 61.5-64.5 109-132.3 109zm110-213.7c-29.5 0-53.5-23.9-53.5-53.5s23.9-53.5 53.5-53.5 53.5 23.9 53.5 53.5-23.9 53.5-53.5 53.5z"/></svg>
        <h2 class="logo-text">Study AI</h2>
      </div>
      <button id="study-close-chatbot" class="material-symbols-rounded">close</button>
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
          <button type="submit" id="study-send-message" class="material-symbols-rounded">arrow_upward</button>
        </div>
      </form>
    </div>
  </div>`;
  document.body.appendChild(root);

  // Overlay to close on outside click
  let overlay = document.querySelector('.tbp-study-chat-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'tbp-study-chat-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;display:none;background:rgba(0,0,0,0.2);z-index:9998;';
    document.body.appendChild(overlay);
  }

  const chatBody = root.querySelector('.chat-body');
  const messageInput = root.querySelector('.message-input');
  const sendMessage = root.querySelector('#study-send-message');
  const fileInput = root.querySelector('#study-file-input');
  const fileUploadWrapper = root.querySelector('.file-upload-wrapper');
  const fileCancelButton = root.querySelector('#study-file-cancel');
  const closeChatbot = root.querySelector('#study-close-chatbot');

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
// Seed: Homework helper that explains but refuses to give the final answer
const SEED_PROMPT = "You are a Homework Helper. Explain concepts and provide step-by-step guidance without giving the final answer. Structure replies as: 1) short concept recap, 2) steps/strategy, 3) similar worked example with different numbers, 4) hint tailored to the user's problem. Be clear and encouraging. If asked directly for the answer, refuse politely and offer a hint instead.";
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
      model: "gemini-1.5-flash-8b",
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

// Initialize emoji picker and handle emoji selection
const picker = new EmojiMart.Picker({
  theme: "light",
  skinTonePosition: "none",
  previewPosition: "none",
  onEmojiSelect: (emoji) => {
    const { selectionStart: start, selectionEnd: end } = messageInput;
    messageInput.setRangeText(emoji.native, start, end, "end");
    messageInput.focus();
  },
  onClickOutside: (e) => {
    if (e.target.id === "emoji-picker") {
      document.body.classList.toggle("show-emoji-picker");
    } else {
      document.body.classList.remove("show-emoji-picker");
    }
  },
});

root.querySelector(".chat-form").appendChild(picker);

sendMessage.addEventListener("click", (e) => handleOutgoingMessage(e));
const fileUploadBtn = root.querySelector("#study-file-upload");
if (fileUploadBtn) fileUploadBtn.addEventListener("click", () => fileInput.click());
closeChatbot.addEventListener("click", () => { root.style.display='none'; overlay.style.display='none'; });

// Open Study AI via data-open="study-ai"
document.addEventListener('click', function(e){
  const target = e.target.closest('[data-open="study-ai"]');
  if (!target) return;
  e.preventDefault();
  root.style.display = 'block';
  overlay.style.display = 'block';
});

overlay.addEventListener('click', ()=> { root.style.display='none'; overlay.style.display='none'; });
})();
