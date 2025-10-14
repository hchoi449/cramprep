// Timetable Page JavaScript

// Current date tracking
let currentDate = new Date();
let currentWeek = new Date(currentDate);
let currentMonth = new Date(currentDate);

// Types (JSDoc for type-safety in JS)
/** @typedef {('Algebra II'|'Geometry'|'Calculus'|'Chemistry'|'Physics'|'Biology')} Subject */
/** @typedef {{ id:string, title:string, school:string, tutorName:string, subject:Subject, start:string, end:string, meetLink?:string, comments?:string, createdBy:'owner'|'system' }} CalendarEvent */

// Color map (single source of truth)
const SUBJECT_COLOR_MAP = {
    'Algebra II': { bg: getComputedStyle(document.documentElement).getPropertyValue('--subject-algebra-bg').trim() || '#8B4513', text:'#ffffff' },
    'Geometry': { bg: getComputedStyle(document.documentElement).getPropertyValue('--subject-geometry-bg').trim() || '#6b3410', text:'#ffffff' },
    'Calculus': { bg: getComputedStyle(document.documentElement).getPropertyValue('--subject-calculus-bg').trim() || '#a0522d', text:'#ffffff' },
    'Chemistry': { bg: getComputedStyle(document.documentElement).getPropertyValue('--subject-chemistry-bg').trim() || '#a86a3d', text:'#ffffff' },
    'Physics': { bg: getComputedStyle(document.documentElement).getPropertyValue('--subject-physics-bg').trim() || '#b07d53', text:'#ffffff' },
    'Biology': { bg: getComputedStyle(document.documentElement).getPropertyValue('--subject-biology-bg').trim() || '#c4946b', text:'#ffffff' }
};

// RBAC (client hint only; server is source of truth)
const CURRENT_ROLE = 'user'; // change to 'owner' to expose owner-only controls

// Lightweight cache for events
let EVENTS_CACHE = { data: /** @type {CalendarEvent[]} */([]), fetchedAt: 0 };

async function fetchEvents() {
    if (Date.now() - EVENTS_CACHE.fetchedAt < 60_000 && EVENTS_CACHE.data.length) return EVENTS_CACHE.data;
    const banner = ensureBanner();
    try {
        const base = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
        const res = await fetch(`${base}/sessions`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('Failed');
        const j = await res.json();
        const events = (j && j.events) ? j.events : [];
        EVENTS_CACHE = { data: events, fetchedAt: Date.now() };
        hideBanner(banner);
        return events;
    } catch {
        showBanner(banner, 'Unable to load sessions');
        EVENTS_CACHE = { data: [], fetchedAt: Date.now() };
        return [];
    }
}

function ensureBanner(){
    let b = document.getElementById('events-banner');
    if (!b) {
        b = document.createElement('div');
        b.id = 'events-banner';
        b.style.cssText = 'position:sticky;top:0;z-index:50;background:#fff3cd;color:#92400e;padding:8px 12px;border:1px solid #fde68a;border-radius:8px;margin:8px auto;max-width:960px;display:none;';
        b.setAttribute('role','status');
        const container = document.querySelector('.timetable-content .container') || document.body;
        container.insertBefore(b, container.firstChild);
    }
    return b;
}
function showBanner(b, msg){ b.textContent = msg; b.style.display = 'block'; }
function hideBanner(b){ if(b){ b.style.display = 'none'; } }

function getMonday(date){
    const d = new Date(date);
    const day = d.getDay();
    const diffToMonday = (day === 0 ? -6 : 1 - day);
    d.setDate(d.getDate() + diffToMonday);
    d.setHours(0,0,0,0);
    return d;
}

function toEst(date){
    // Convert to America/New_York components
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', hour12:false, year:'numeric', month:'2-digit', day:'2-digit' });
    const parts = fmt.formatToParts(date).reduce((a,p)=> (a[p.type]=p.value, a), {});
    const est = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`);
    return est;
}

function hourToSlotLabel(h24){
    if (h24 === 0) return '00:00';
    if (h24 === 12) return '12:00';
    const h = h24 % 12;
    return `${String(h).padStart(2,'0')}:00`;
}

function renderWeekEvents(startOfWeek){
    // Clear previous autogen entries
    document.querySelectorAll('.class-slot.autogen').forEach(n => n.parentNode.removeChild(n));
    const daySlots = Array.from(document.querySelectorAll('.week-grid .day-column .day-slots'));
    if (daySlots.length !== 7) return;
    const tz = 'America/New_York';
    // Build EST date keys for each displayed day (Mon..Sun)
    const weekDaysYmd = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(startOfWeek);
        d.setDate(startOfWeek.getDate() + i);
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
        weekDaysYmd.push(`${parts.year}-${parts.month}-${parts.day}`);
    }
    EVENTS_CACHE.data.forEach(ev => {
        // Compute event start/end components in EST
        const s0 = new Date(ev.start);
        const e0 = new Date(ev.end);
        const sp = new Intl.DateTimeFormat('en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(s0).reduce((a,p)=> (a[p.type]=p.value, a), {});
        const evYmd = `${sp.year}-${sp.month}-${sp.day}`;
        const dayIndex = weekDaysYmd.indexOf(evYmd);
        if (dayIndex < 0) return; // Not in displayed week (EST)
        const hour = Number(sp.hour);
        const targetCol = daySlots[dayIndex];
        const slot = document.createElement('div');
        const subjSafe = (ev.subject && String(ev.subject).toLowerCase().replace(/\s+/g,'-')) || 'general';
        slot.className = `class-slot autogen ${subjSafe}`;
        if (ev.subject) slot.setAttribute('data-subject', ev.subject);
        slot.setAttribute('tabindex','0');
        slot.setAttribute('role','button');
        // Position mapping (EST): 12:00 => 0px, each hour => +75px (with minute precision)
        const SCALE_PX_PER_HOUR = 75;
        const minutes = Number(sp.minute || 0);
        const offsetHours = (hour === 0 ? 12 : hour) - 12; // 12->0, 13->1 ... 23->11, 0->12
        let topPx = (hour === 0 ? 12 : offsetHours) * SCALE_PX_PER_HOUR + (minutes/60)*SCALE_PX_PER_HOUR;
        if (topPx < 0) topPx = 0; // clamp AM times to visible area
        slot.style.top = `${topPx}px`;
        // Height based on duration (75px/hr)
        const durMin = Math.max(15, Math.round((e0 - s0) / 60000));
        slot.style.height = `${(durMin/60)*SCALE_PX_PER_HOUR}px`;
        // Compact view: title + time range
        const tf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        const timeRange = `${tf.format(s0)} 01 ${tf.format(e0)}`.replace('  ', ' ');
        slot.innerHTML = `<div class="class-info" style="font-family: inherit;">
            <h4 title="${ev.title}">${ev.title}</h4>
            <div class="time">${timeRange}</div>
        </div>`;
        // Ensure clean time text and explicit hyphen separator
        try {
            const fixedFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
            const fixed = `${fixedFmt.format(s0)} - ${fixedFmt.format(e0)}`;
            const t = slot.querySelector('.time');
            if (t) t.textContent = fixed.replace(/[^APM\d: \-]/gi, '');
        } catch {}
        const c = SUBJECT_COLOR_MAP[ev.subject];
        if (c) { slot.style.background = c.bg; slot.style.color = c.text; }
        const open = (e_)=>{ e_ && e_.preventDefault(); showEventDetails(ev); };
        slot.addEventListener('click', open);
        slot.addEventListener('keydown', function(e_){ if(e_.key==='Enter'||e_.key===' '){ open(e_);} });
        targetCol.appendChild(slot);
    });
}

// Initialize the page
document.addEventListener('DOMContentLoaded', function() {
    initializeTimetable();
    setupEventListeners();
    updateWeekDisplay();
    fetchEvents().then(()=>{
        const monday = getMonday(currentWeek);
        renderWeekEvents(monday);
    });
    updateMonthDisplay();

    // AI chat UI removed; button retained for future integration
    try { setupAssignmentsDrawer(); } catch {}

    // Open assignments drawer if URL param drawer=open is present
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('drawer') === 'open') {
            const tab = document.getElementById('assignments-tab');
            if (tab) tab.click(); // triggers the same toggle logic and ensures tab stays in sync
        }
    } catch {}
});

// Initialize timetable functionality
function initializeTimetable() {
    // Set data-time attributes for class positioning
    const classSlots = document.querySelectorAll('.class-slot');
    classSlots.forEach(slot => {
        const timeText = slot.querySelector('.time').textContent;
        const startTime = timeText.split(' - ')[0];
        slot.setAttribute('data-time', startTime);
    });
}

// Setup event listeners
function setupEventListeners() {
    // View toggle buttons
    const toggleBtns = document.querySelectorAll('.toggle-btn');
    toggleBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const view = this.getAttribute('data-view');
            switchView(view);
        });
    });

    // Book buttons
    const bookBtns = document.querySelectorAll('.book-btn');
    bookBtns.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const classSlot = this.closest('.class-slot');
            const subject = classSlot.getAttribute('data-subject');
            const classInfo = classSlot.querySelector('.class-info h4').textContent;
            const tutor = classSlot.querySelector('.class-info p').textContent;
            const time = classSlot.querySelector('.time').textContent;
            
            bookClass(subject, classInfo, tutor, time);
        });
    });

    // Class slot clicks
    const classSlots = document.querySelectorAll('.class-slot');
    classSlots.forEach(slot => {
        slot.addEventListener('click', function() {
            const subject = this.getAttribute('data-subject');
            const classInfo = this.querySelector('.class-info h4').textContent;
            const tutor = this.querySelector('.class-info p').textContent;
            const time = this.querySelector('.time').textContent;
            
            showClassDetails(subject, classInfo, tutor, time);
        });
    });
}

// Switch between week and month views
function switchView(view) {
    const weekView = document.getElementById('week-view');
    const monthView = document.getElementById('month-view');
    const toggleBtns = document.querySelectorAll('.toggle-btn');
    
    // Update active button
    toggleBtns.forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-view') === view) {
            btn.classList.add('active');
        }
    });
    
    // Show/hide views
    if (view === 'week') {
        weekView.style.display = 'block';
        monthView.style.display = 'none';
    } else {
        weekView.style.display = 'none';
        monthView.style.display = 'block';
        generateMonthView();
    }
}

// Navigation functions
function previousWeek() {
    currentWeek.setDate(currentWeek.getDate() - 7);
    updateWeekDisplay();
    try { refreshAssignmentsForCurrentWeek(); } catch {}
}

function nextWeek() {
    currentWeek.setDate(currentWeek.getDate() + 7);
    updateWeekDisplay();
    try { refreshAssignmentsForCurrentWeek(); } catch {}
}

function previousMonth() {
    currentMonth.setMonth(currentMonth.getMonth() - 1);
    updateMonthDisplay();
    generateMonthView();
}

function nextMonth() {
    currentMonth.setMonth(currentMonth.getMonth() + 1);
    updateMonthDisplay();
    generateMonthView();
}

// Update week display
function updateWeekDisplay() {
    // Compute Monday as the first day of the week (ISO week)
    const startOfWeek = new Date(currentWeek);
    const day = startOfWeek.getDay(); // 0 (Sun) .. 6 (Sat)
    const diffToMonday = (day === 0 ? -6 : 1 - day); // if Sun, go back 6; else 1 - day
    startOfWeek.setDate(startOfWeek.getDate() + diffToMonday);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    
    const options = { month: 'long', day: 'numeric' };
    const startStr = startOfWeek.toLocaleDateString('en-US', options);
    const endStr = endOfWeek.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    
    document.getElementById('current-week').textContent = `${startStr} - ${endStr}`;

    // Populate dates under each day header (Mon..Sun) based on Monday start
    const dayHeaders = document.querySelectorAll('.week-grid .day-column .day-header');
    const dayColumns = document.querySelectorAll('.week-grid .day-column');
    const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    if (dayHeaders.length === 7) {
        for (let i = 0; i < 7; i++) {
            const dateForCol = new Date(startOfWeek);
            dateForCol.setDate(startOfWeek.getDate() + i);
            const dateStr = dateForCol.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            dayHeaders[i].innerHTML = `${dayNames[i]}<div class="day-date">${dateStr}</div>`;
            // Highlight present day (EST)
            try {
                const tz = 'America/New_York';
                const todayParts = new Intl.DateTimeFormat('en-US',{ timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date()).reduce((a,p)=> (a[p.type]=p.value,a),{});
                const colParts = new Intl.DateTimeFormat('en-US',{ timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(dateForCol).reduce((a,p)=> (a[p.type]=p.value,a),{});
                const isToday = todayParts.year===colParts.year && todayParts.month===colParts.month && todayParts.day===colParts.day;
                if (dayColumns[i]) {
                    if (isToday) dayColumns[i].classList.add('is-today'); else dayColumns[i].classList.remove('is-today');
                }
            } catch {}
        }
    }

    // Re-render events for the newly displayed week (EST-aware)
    renderWeekEvents(startOfWeek);
    try {
        const header = document.querySelector('#assignments-drawer .drawer-header h3');
        if (header) header.textContent = 'Assignments (Next 7 Days)';
    } catch {}
}

// Accessible event modal (basic)
function showEventDetails(/** @type {CalendarEvent} */event){
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-modal','true');
    overlay.setAttribute('aria-label','Event details');
    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:12px;max-width:520px;width:calc(100% - 40px);padding:20px;box-shadow:0 20px 60px rgba(0,0,0,0.2);';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'btn btn-secondary';
    closeBtn.style.cssText = 'float:right;margin-bottom:8px;';
    closeBtn.addEventListener('click', ()=>document.body.removeChild(overlay));
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) document.body.removeChild(overlay); });
    document.addEventListener('keydown', escHandler);
    function escHandler(e){ if(e.key==='Escape'){ document.removeEventListener('keydown', escHandler); if(overlay.parentNode) document.body.removeChild(overlay);} }
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true });
    const timeStr = `${fmt.format(new Date(event.start))} – ${fmt.format(new Date(event.end))} (EST)`;
    card.innerHTML = `
        <h3 style="margin-top:0;">${event.title}</h3>
        <p><strong>School:</strong> ${event.school}</p>
        <p><strong>Tutor:</strong> ${event.tutorName}</p>
        <p><strong>Subject:</strong> ${event.subject}</p>
        <p><strong>When:</strong> ${timeStr}</p>
        
        ${event.comments ? `<p><strong>Comments:</strong><br>${event.comments}</p>`: ''}
    `;
    card.insertBefore(closeBtn, card.firstChild);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    closeBtn.focus();
}

// utils
async function fileToDataURL(file){
    return new Promise((resolve, reject)=>{
        const reader = new FileReader();
        reader.onload = ()=> resolve(String(reader.result||''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Update month display
function updateMonthDisplay() {
    const options = { month: 'long', year: 'numeric' };
    const monthStr = currentMonth.toLocaleDateString('en-US', options);
    document.getElementById('current-month').textContent = monthStr;
}

// Generate month view calendar
function generateMonthView() {
    const monthGrid = document.getElementById('month-grid');
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    
    // Get first day of month and number of days
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDay = firstDay.getDay();
    
    // Clear existing content
    monthGrid.innerHTML = '';
    
    // Add day headers
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayNames.forEach(day => {
        const dayHeader = document.createElement('div');
        dayHeader.className = 'month-day-header';
        dayHeader.textContent = day;
        monthGrid.appendChild(dayHeader);
    });
    
    // Add empty cells for days before month starts
    for (let i = 0; i < startingDay; i++) {
        const emptyDay = document.createElement('div');
        emptyDay.className = 'month-day other-month';
        monthGrid.appendChild(emptyDay);
    }
    
    // Keep references to day cells to append events later
    const dayCells = [];
    for (let day = 1; day <= daysInMonth; day++) {
        const dayElement = document.createElement('div');
        dayElement.className = 'month-day';
        const today = new Date();
        if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
            dayElement.classList.add('today');
        }
        const dayHeader = document.createElement('div');
        dayHeader.className = 'month-day-header';
        dayHeader.textContent = day;
        dayElement.appendChild(dayHeader);
        monthGrid.appendChild(dayElement);
        dayCells.push(dayElement);
    }
    
    // Add empty cells for days after month ends
    const totalCells = 42; // 6 rows * 7 days
    const remainingCells = totalCells - (startingDay + daysInMonth);
    for (let i = 0; i < remainingCells; i++) {
        const emptyDay = document.createElement('div');
        emptyDay.className = 'month-day other-month';
        monthGrid.appendChild(emptyDay);
    }
    // Render events for the currentMonth (EST-aware)
    try {
        const tz = 'America/New_York';
        EVENTS_CACHE.data.forEach(ev => {
            const d0 = new Date(ev.start);
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12: true }).formatToParts(d0).reduce((a,p)=> (a[p.type]=p.value,a), {});
            const y = Number(parts.year);
            const m = Number(parts.month) - 1; // 0-based
            const dayNum = Number(parts.day);
            if (y !== year || m !== month) return;
            const cell = dayCells[dayNum - 1];
            if (!cell) return;
            const pill = document.createElement('div');
            const subjSlug = String(ev.subject || '').toLowerCase().replace(/\s+/g,'-');
            pill.className = `month-class ${subjSlug}`;
            const startStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour:'numeric', minute:'2-digit' }).format(d0);
            pill.textContent = `${ev.title || ev.subject || 'Class'} • ${startStr}`;
            pill.title = `${ev.subject} with ${ev.tutorName}`;
            cell.appendChild(pill);
        });
    } catch {}
}

// Book class function
function bookClass(subject, classInfo, tutor, time) {
    // Create booking modal or redirect to booking page
    const message = `Booking: ${classInfo}\nTutor: ${tutor}\nTime: ${time}\nSubject: ${subject}`;
    
    // For now, show an alert. In a real application, this would open a modal or redirect
    alert(`Booking Request:\n\n${message}\n\nThis would typically open a booking form or redirect to a payment page.`);
    
    // You could also redirect to a booking page:
    // window.location.href = `booking.html?subject=${encodeURIComponent(subject)}&class=${encodeURIComponent(classInfo)}&tutor=${encodeURIComponent(tutor)}&time=${encodeURIComponent(time)}`;
}

// Show class details
function showClassDetails(subject, classInfo, tutor, time) {
    const message = `Class Details:\n\nClass: ${classInfo}\nTutor: ${tutor}\nTime: ${time}\nSubject: ${subject}\n\nThis class covers fundamental concepts in ${subject.toLowerCase()}.`;
    
    alert(message);
}

// Mobile menu toggle (reuse from index.js)
function toggleMobileMenu() {
    const mobileMenu = document.getElementById('mobile-menu');
    if (!mobileMenu) return;
    const mobileToggle = document.querySelector('.mobile-menu-btn');
    
    const isOpen = mobileMenu.style.display === 'block' || mobileMenu.classList.contains('active');
    if (isOpen) {
        mobileMenu.style.display = 'none';
        mobileMenu.classList.remove('active');
        if (mobileToggle) mobileToggle.classList.remove('active');
    } else {
        mobileMenu.style.display = 'block';
        mobileMenu.classList.add('active');
        if (mobileToggle) mobileToggle.classList.add('active');
    }
}

// Initialize mobile menu as closed
document.addEventListener('DOMContentLoaded', function() {
    const mobileMenu = document.getElementById('mobile-menu');
    if (mobileMenu) {
        mobileMenu.style.display = 'none';
        mobileMenu.classList.remove('active');
    }
});

// Add smooth scrolling for navigation links
document.addEventListener('DOMContentLoaded', function() {
    const navLinks = document.querySelectorAll('a[href^="#"]');
    
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('href');
            const targetSection = document.querySelector(targetId);
            
            if (targetSection) {
                const headerHeight = document.querySelector('.header').offsetHeight;
                const targetPosition = targetSection.offsetTop - headerHeight;
                
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
});

// ===== Assignments Drawer + ICS parsing =====
function setupAssignmentsDrawer(){
    const tab = document.getElementById('assignments-tab');
    const drawer = document.getElementById('assignments-drawer');
    const closeBtn = drawer ? drawer.querySelector('.drawer-close') : null;
    if (!tab || !drawer) return;
    const toggle = (open)=>{
        const isOpen = typeof open === 'boolean' ? open : !drawer.classList.contains('active');
        if (isOpen) {
            drawer.classList.add('active');
            tab.setAttribute('aria-expanded','true');
            drawer.setAttribute('aria-hidden','false');
            try { document.body.classList.add('drawer-open'); } catch {}
            refreshAssignmentsForCurrentWeek();
        } else {
            drawer.classList.remove('active');
            tab.setAttribute('aria-expanded','false');
            drawer.setAttribute('aria-hidden','true');
            try { document.body.classList.remove('drawer-open'); } catch {}
        }
    };
    tab.addEventListener('click', ()=> toggle());
    if (closeBtn) closeBtn.addEventListener('click', ()=> toggle(false));
    // Click outside to close
    document.addEventListener('click', function(e){
        if (!drawer.classList.contains('active')) return;
        const withinDrawer = drawer.contains(e.target);
        const onTab = tab.contains(e.target);
        if (!withinDrawer && !onTab) toggle(false);
    });
    // Collapsible headers: click caret only to toggle; default expanded
    try {
        function wireToggle(id){
            const title = document.querySelector(`#${id} .drawer-section-title`);
            if (!title) return;
            const caret = title.querySelector('.drawer-caret');
            if (caret) {
                caret.setAttribute('role','button');
                caret.setAttribute('tabindex','0');
                const handler = function(){
                    const s = document.getElementById(id);
                    if (!s) return;
                    const isCollapsed = s.classList.toggle('collapsed');
                    caret.textContent = isCollapsed ? '▸' : '▾';
                };
                caret.addEventListener('click', handler);
                caret.addEventListener('keydown', function(e){ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); handler(); } });
            }
            // ensure default expanded caret
            if (caret) caret.textContent = '▾';
            const s = document.getElementById(id);
            if (s) s.classList.remove('collapsed');
        }
        wireToggle('section-exams');
        wireToggle('section-homework');
    } catch {}
}

async function refreshAssignmentsForCurrentWeek(){
    try {
        const list = document.getElementById('assignments-list');
        const empty = document.querySelector('.drawer-empty');
        const loading = document.getElementById('assignments-loading');
        if (list) list.innerHTML = '';
        if (empty) empty.style.display = 'none';
        if (loading) loading.style.display = 'flex';
        const profile = await fetchProfile();
        const token = (localStorage && localStorage.getItem('tbp_token')) || '';
        if (!token) {
            if (loading) loading.style.display = 'none';
            if (empty) { empty.textContent = 'Please login to view your assignments.'; empty.style.display = 'block'; }
            return;
        }
        const icsUrl = profile && profile.icsUrl ? String(profile.icsUrl).trim() : '';
        if (!icsUrl) {
            if (loading) loading.style.display = 'none';
            if (empty) {
                empty.innerHTML = 'Please input the iCal (.ics) URL <a href="account.html">here</a>.';
                empty.style.display = 'block';
            }
            return;
        }
        const base = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
        const res = await fetch(`${base}/auth/ics?url=${encodeURIComponent(icsUrl)}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('Failed to fetch calendar');
        const text = await res.text();
        const events = parseIcs(text);
        const weekEvents = filterEventsToDisplayedWeek(events);
        renderAssignmentsList(weekEvents);
        if (loading) loading.style.display = 'none';
    } catch (e) {
        const loading = document.getElementById('assignments-loading');
        if (loading) loading.style.display = 'none';
        const empty = document.querySelector('.drawer-empty');
        if (empty) { empty.textContent = 'Unable to load assignments.'; empty.style.display = 'block'; }
    }
}

async function fetchProfile(){
    try {
        const token = (localStorage && localStorage.getItem('tbp_token')) || '';
        if (!token) return null;
        const base = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/,'') : '';
        const res = await fetch(`${base}/auth/profile`, { headers: { 'Authorization': `Bearer ${token}` } });
        const j = await res.json().catch(()=>({}));
        if (res.ok && j && j.profile) return j.profile;
        return null;
    } catch { return null; }
}

function parseIcs(icsText){
    const events = [];
    const lines = icsText.split(/\r?\n/);
    let cur = null;
    const unfolded = [];
    for (let i=0;i<lines.length;i++){
        const line = lines[i];
        if (/^\s/.test(line) && unfolded.length){
            unfolded[unfolded.length-1] += line.trim();
        } else {
            unfolded.push(line);
        }
    }
    for (const raw of unfolded){
        const line = raw.trim();
        if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
        if (line === 'END:VEVENT') { if (cur) { events.push(cur); cur = null; } continue; }
        if (!cur) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const keyPart = line.slice(0, idx);
        const val = line.slice(idx+1);
        const key = keyPart.split(';')[0];
        if (key === 'DTSTART' || key.startsWith('DTSTART')) cur.DTSTART = val;
        else if (key === 'DTEND' || key.startsWith('DTEND')) cur.DTEND = val;
        else if (key === 'SUMMARY') cur.SUMMARY = decodeIcsText(val);
        else if (key === 'DESCRIPTION') cur.DESCRIPTION = decodeIcsText(val);
        else if (key === 'URL' || key === 'URL;VALUE=URI') cur.URL = val;
    }
    return events
        .map(e => ({
            title: e.SUMMARY || 'Assignment',
            start: icsToDate(e.DTSTART),
            end: icsToDate(e.DTEND || e.DTSTART),
            url: e.URL || null,
            description: e.DESCRIPTION || null
        }))
        .filter(e => !!e.start);
}

function decodeIcsText(s){
    return String(s||'').replace(/\\n/g,'\n').replace(/\\,/g,',').replace(/\\;/g,';');
}

function icsToDate(v){
    if (!v) return null;
    if (/^\d{8}$/.test(v)) {
        const y = Number(v.slice(0,4));
        const m = Number(v.slice(4,6));
        const d = Number(v.slice(6,8));
        // Use noon UTC for all-day dates to avoid prior-day shift in US timezones
        return new Date(Date.UTC(y, m-1, d, 12, 0, 0));
    }
    if (/^\d{8}T\d{6}Z$/.test(v)) {
        const y = Number(v.slice(0,4));
        const m = Number(v.slice(4,6));
        const d = Number(v.slice(6,8));
        const hh = Number(v.slice(9,11));
        const mm = Number(v.slice(11,13));
        const ss = Number(v.slice(13,15));
        return new Date(Date.UTC(y, m-1, d, hh, mm, ss));
    }
    const dt = new Date(v);
    return isNaN(dt.getTime()) ? null : dt;
}

function filterEventsToDisplayedWeek(events){
    // Show next 7 days from today (current day at 00:00) — no past dates
    const now = new Date();
    now.setHours(0,0,0,0);
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    return events.filter(ev => ev.start && ev.start >= now && ev.start < end);
}

function renderAssignmentsList(events){
    const empty = document.querySelector('.drawer-empty');
    const examsRoot = document.getElementById('exams-groups');
    const hwRoot = document.getElementById('homework-groups');
    if (!examsRoot || !hwRoot) return;
    examsRoot.innerHTML = '';
    hwRoot.innerHTML = '';
    if (!events || !events.length) { if (empty) empty.style.display = 'block'; return; }
    if (empty) empty.style.display = 'none';

    const isAssessment = (title)=>{
        const t = String(title||'').toLowerCase();
        // match whole words only (e.g., 'test' not matching 'contest')
        return /\b(exams?|tests?|assessments?|quiz(?:zes)?)\b/.test(t);
    };

    const exams = [];
    const hw = [];
    events.forEach(e => (isAssessment(e.title) ? exams : hw).push(e));

    const tz = 'America/New_York';
    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday:'long', month:'short', day:'numeric' });

    const mkGroups = (arr)=>{
        const map = new Map();
        arr.sort((a,b)=> (a.start||0) - (b.start||0));
        for(const ev of arr){
            const key = ev.start ? dayFmt.format(ev.start) : 'Unknown';
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(ev);
        }
        return map;
    };

    const renderGroups = (map, root)=>{
        for (const [day, items] of map.entries()){
            const wrap = document.createElement('div');
            wrap.className = 'weekday';
            wrap.innerHTML = `<h5>${day}</h5>`;
            const ul = document.createElement('div');
            ul.className = 'pill-list';
            for (const ev of items){
                const pill = document.createElement('div');
                pill.className = 'pill';
                const subj = (ev.subject || ev.title || '').toLowerCase();
                pill.setAttribute('data-subject', subj);
                pill.innerHTML = `${escapeHtml(ev.title)} <span class="help-btn" data-title="${escapeHtml(ev.title)}" data-when="${ev.start ? ev.start.toISOString() : ''}">Get Help</span>`;
                ul.appendChild(pill);
            }
            wrap.appendChild(ul);
            root.appendChild(wrap);
        }
    };

    renderGroups(mkGroups(exams), examsRoot);
    renderGroups(mkGroups(hw), hwRoot);

    // Wire Get Help handlers
    document.querySelectorAll('.pill .help-btn').forEach(function(btn){
        btn.addEventListener('click', function(e){
            e.preventDefault(); e.stopPropagation();
            try {
                const title = this.getAttribute('data-title') || '';
                const whenIso = this.getAttribute('data-when') || '';
                const when = whenIso ? new Date(whenIso) : null;
                // infer help type from title keywords
                const t = String(title||'').toLowerCase();
                const helpType = /\b(exams?|tests?|assessments?|quiz(?:zes)?)\b/.test(t) ? 'exam' : 'homework';
                // Keep drawer open; just open Schedule AI
                const drawer = document.getElementById('assignments-drawer');
                const tab = document.getElementById('assignments-tab');
                if (drawer) { drawer.classList.add('active'); drawer.setAttribute('aria-hidden','false'); }
                if (tab) tab.setAttribute('aria-expanded','true');
                // Open Schedule AI
                if (window.tbpOpenScheduleAI) { window.tbpOpenScheduleAI(title, when ? when.toISOString() : '', helpType); }

                // If no availability becomes found, send fallback form (deferred demonstration)
                // Provide a helper function exposed on window to be called by chatbot flow when needed
                window.tbpFallbackNotify = async function(){
                    try {
                        const raw = localStorage.getItem('tbp_user');
                        const user = raw ? JSON.parse(raw) : {};
                        const studentName = user && (user.fullName || user.email || 'Unknown');
                        const due = when ? new Intl.DateTimeFormat('en-US',{ month:'short', day:'numeric', year:'numeric' }).format(when) : 'Unknown';
                        const payload = { name: studentName, assignment: title, dueDate: due };
                        await fetch('https://formspree.io/f/mvgbnkgn', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
                    } catch {}
                };
            } catch {}
        });
    });
}

function escapeHtml(s){
    return String(s||'').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]||c));
}
