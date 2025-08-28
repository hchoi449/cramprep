// Timetable Page JavaScript

// Current date tracking
let currentDate = new Date();
let currentWeek = new Date(currentDate);
let currentMonth = new Date(currentDate);

// Initialize the page
document.addEventListener('DOMContentLoaded', function() {
    initializeTimetable();
    setupEventListeners();
    updateWeekDisplay();
    updateMonthDisplay();
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
    const startOfWeek = new Date(currentWeek);
    startOfWeek.setDate(currentWeek.getDate() - currentWeek.getDay());
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    
    const options = { month: 'long', day: 'numeric' };
    const startStr = startOfWeek.toLocaleDateString('en-US', options);
    const endStr = endOfWeek.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    
    document.getElementById('current-week').textContent = `${startStr} - ${endStr}`;

    // Populate dates under each day header (Mon..Sun)
    const dayHeaders = document.querySelectorAll('.week-grid .day-column .day-header');
    const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    if (dayHeaders.length === 7) {
        for (let i = 0; i < 7; i++) {
            const dateForCol = new Date(startOfWeek);
            const offset = (i + 1) % 7; // Monday=+1 ... Sunday=0
            dateForCol.setDate(startOfWeek.getDate() + offset);
            const dateStr = dateForCol.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            dayHeaders[i].innerHTML = `${dayNames[i]}<div class="day-date">${dateStr}</div>`;
        }
    }

    // Add a Geometry meeting on Tuesday 6:00–7:30 PM (auto-generated)
    // First remove any prior auto-generated entries to avoid duplicates
    document.querySelectorAll('.class-slot.geometry.autogen').forEach(n => n.parentNode.removeChild(n));
    const daySlots = document.querySelectorAll('.week-grid .day-column .day-slots');
    if (daySlots.length >= 2) {
        const tuesdaySlots = daySlots[1]; // Monday=0, Tuesday=1
        const slot = document.createElement('div');
        slot.className = 'class-slot geometry autogen';
        slot.setAttribute('data-subject', 'Geometry');
        slot.setAttribute('data-time', '18:00'); // 6 PM positioning
        slot.style.height = '60px'; // 1.5 hours at 40px/hour
        slot.innerHTML = `
            <div class="class-info">
                <h4>Geometry</h4>
                <p>Group Session</p>
                <div class="time">6:00 PM - 7:30 PM</div>
                <button class="book-btn">Book</button>
            </div>
        `;
        tuesdaySlots.appendChild(slot);
        const bookBtn = slot.querySelector('.book-btn');
        if (bookBtn) {
            bookBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                bookClass('Geometry', 'Geometry Group Session', 'ThinkBigPrep Tutor', '6:00 PM - 7:30 PM');
            });
        }
    }
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
    
    // Add days of the month
    for (let day = 1; day <= daysInMonth; day++) {
        const dayElement = document.createElement('div');
        dayElement.className = 'month-day';
        
        // Check if it's today
        const today = new Date();
        if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
            dayElement.classList.add('today');
        }
        
        // Add day number
        const dayHeader = document.createElement('div');
        dayHeader.className = 'month-day-header';
        dayHeader.textContent = day;
        dayElement.appendChild(dayHeader);
        
        // No demo classes added; days remain empty by default
        monthGrid.appendChild(dayElement);
    }
    
    // Add empty cells for days after month ends
    const totalCells = 42; // 6 rows * 7 days
    const remainingCells = totalCells - (startingDay + daysInMonth);
    for (let i = 0; i < remainingCells; i++) {
        const emptyDay = document.createElement('div');
        emptyDay.className = 'month-day other-month';
        monthGrid.appendChild(emptyDay);
    }
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
