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
        const res = await fetch('/api/events', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('Failed');
        const { events } = await res.json();
        EVENTS_CACHE = { data: events, fetchedAt: Date.now() };
        hideBanner(banner);
        return events;
    } catch {
        showBanner(banner, 'Unable to load events');
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
        if (hour < 12 && hour !== 0) return; // restrict to 12PM..12AM
        const targetCol = daySlots[dayIndex];
        const slot = document.createElement('div');
        slot.className = `class-slot autogen ${ev.subject.toLowerCase().replace(/\s+/g,'-')}`;
        slot.setAttribute('data-subject', ev.subject);
        slot.setAttribute('tabindex','0');
        slot.setAttribute('role','button');
        // Position mapping (EST): 12:00 => 0px, each hour => +75px (with minute precision)
        const SCALE_PX_PER_HOUR = 75;
        const minutes = Number(sp.minute || 0);
        const offsetHours = (hour === 0 ? 12 : hour) - 12; // 12->0, 13->1 ... 23->11, 0->12
        const topPx = (hour === 0 ? 12 : offsetHours) * SCALE_PX_PER_HOUR + (minutes/60)*SCALE_PX_PER_HOUR;
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
        // Ensure clean time text and explicit "to" separator
        try {
            const fixedFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
            const fixed = `${fixedFmt.format(s0)} to ${fixedFmt.format(e0)}`;
            const t = slot.querySelector('.time');
            if (t) t.textContent = fixed.replace(/[^APM\d: \-to]/gi, '');
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
}

function nextWeek() {
    currentWeek.setDate(currentWeek.getDate() + 7);
    updateWeekDisplay();
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
    const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    if (dayHeaders.length === 7) {
        for (let i = 0; i < 7; i++) {
            const dateForCol = new Date(startOfWeek);
            dateForCol.setDate(startOfWeek.getDate() + i);
            const dateStr = dateForCol.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            dayHeaders[i].innerHTML = `${dayNames[i]}<div class="day-date">${dateStr}</div>`;
        }
    }

    // Re-render events for the newly displayed week (EST-aware)
    renderWeekEvents(startOfWeek);
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
        ${event.meetLink ? `<p><strong>Google Meet:</strong> <a href="${event.meetLink}" target="_blank" rel="noreferrer">Join</a></p>`: ''}
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
    const mobileToggle = document.querySelector('.mobile-menu-toggle');
    
    if (mobileMenu.style.display === 'block' || mobileMenu.classList.contains('active')) {
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
