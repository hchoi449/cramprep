
// Debug logging
console.log('AMC Academy Website JavaScript loaded');
console.log('Current URL:', window.location.href);
console.log('CSS loaded:', document.styleSheets.length, 'stylesheets');

// Mobile menu toggle functionality
function toggleMobileMenu() {
    const mobileMenu = document.getElementById('mobile-menu');
    if (!mobileMenu) return;
    const mobileToggle = document.querySelector('.mobile-menu-btn');
    
    const isOpen = mobileMenu.style.display === 'block' || mobileMenu.classList.contains('active');
    if (isOpen) {
        // Close menu
        mobileMenu.style.display = 'none';
        mobileMenu.classList.remove('active');
        if (mobileToggle) mobileToggle.classList.remove('active');
    } else {
        // Open menu
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
    
    // Add click event to mobile menu toggle
    const mobileToggle = document.querySelector('.mobile-menu-btn');
    if (mobileToggle) {
        mobileToggle.addEventListener('click', toggleMobileMenu);
    }
});

// Smooth scrolling for navigation links
document.addEventListener('DOMContentLoaded', function() {
    // Get all navigation links
    const navLinks = document.querySelectorAll('a[href^="#"]');
    
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            const href = this.getAttribute('href') || '';
            // Skip smooth scroll for enrollment trigger links
            if (this.classList.contains('student-hub-link') || href.includes('#student-hub')) {
                return; // let custom handler manage it
            }

            e.preventDefault();
            const targetId = href;
            const targetSection = document.querySelector(targetId);
            if (targetSection) {
                const mobileMenu = document.getElementById('mobile-menu');
                if (mobileMenu && mobileMenu.style.display === 'block') {
                    mobileMenu.style.display = 'none';
                }
                const headerHeight = document.querySelector('.header').offsetHeight;
                const targetPosition = targetSection.offsetTop - headerHeight;
                window.scrollTo({ top: targetPosition, behavior: 'smooth' });
            }
        });
    });
    
    // Add scroll effect to header
    const header = document.querySelector('.header');
    window.addEventListener('scroll', function() {
        if (window.scrollY > 100) {
            header.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.1)';
        } else {
            header.style.boxShadow = 'none';
        }
    });
    
    // Add animation on scroll for elements
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);
    
    // Observe elements for animation
    const animateElements = document.querySelectorAll('.coach-card, .course-card, .story-card, .feature');
    animateElements.forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(el);
    });
});

// Removed legacy alert for "Schedule Now"; handled by enrollment modal wiring below

// Add loading animation
window.addEventListener('load', function() {
    document.body.style.opacity = '1';
});

// Add some interactive hover effects
document.addEventListener('DOMContentLoaded', function() {
    // Add hover effects to coach cards
    const coachCards = document.querySelectorAll('.coach-card');
    coachCards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-8px)';
            this.style.boxShadow = '0 15px 30px rgba(0, 0, 0, 0.15)';
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
            this.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
        });
    });
    
    // Add hover effects to course cards
    const courseCards = document.querySelectorAll('.course-card');
    courseCards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-5px)';
            this.style.boxShadow = '0 10px 20px rgba(0, 0, 0, 0.1)';
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
            this.style.boxShadow = 'none';
        });
    });
    
    // Add hover effects to story cards
    const storyCards = document.querySelectorAll('.story-card');
    storyCards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-3px)';
            this.style.boxShadow = '0 8px 15px rgba(0, 0, 0, 0.1)';
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
            this.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
        });
    });

    // Enrollment modal wiring (inject if missing so other pages can use it)
    let enrollModal = document.getElementById('enrollModal');
    let enrollForm = document.getElementById('enrollForm');
    if (!enrollModal) {
        const modalHtml = `
        <div id="enrollModal" class="modal" aria-hidden="true" role="dialog" aria-labelledby="enrollTitle">
            <div class="modal-overlay" data-close-modal></div>
            <div class="modal-content">
                <button class="modal-close" aria-label="Close" data-close-modal>&times;</button>
                <h3 id="enrollTitle" class="section-title" style="font-size: 1.6rem;">Enrollment Request</h3>
                <p class="section-description" style="margin-bottom: 18px;">Fill out the form and we’ll reach out shortly.</p>
                <form id="enrollForm" novalidate>
                    <div class="enroll-grid">
                        <div>
                            <label for="parentName">Parent Name <span class="required-star">*</span></label>
                            <input id="parentName" name="parentName" type="text" placeholder="e.g., Homer Simpson" required>
                            <div class="field-error">Parent name is required.</div>
                        </div>
                        <div>
                            <label for="studentName">Student Name <span class="required-star">*</span></label>
                            <input id="studentName" name="studentName" type="text" placeholder="e.g., Bart Simpson" required>
                            <div class="field-error">Student name is required.</div>
                        </div>
                        <div>
                            <label for="studentGrade">Student Grade <span class="required-star">*</span></label>
                            <input id="studentGrade" name="studentGrade" type="text" placeholder="e.g., 9th or Freshman" required>
                            <div class="field-error">Student grade is required.</div>
                        </div>
                        <div>
                            <label for="school">School <span class="required-star">*</span></label>
                            <input id="school" name="school" type="text" required>
                            <div class="field-error">School is required.</div>
                        </div>
                        <div class="full">
                            <label for="subject">Subject <span class="required-star">*</span></label>
                            <select id="subject" name="subject" required>
                                <option value="">Select a subject</option>
                                <option>Algebra</option>
                                <option>Geometry</option>
                                <option>Pre-Calculus</option>
                                <option>Calculus</option>
                                <option>Physics</option>
                                <option>Chemistry</option>
                                <option>Biology</option>
                                <option>Computer Science</option>
                                <option>SAT</option>
                                <option>ACT</option>
                            </select>
                            <div class="field-error">Subject is required.</div>
                        </div>
                        <div class="full">
                            <label for="preferredPlan">Preferred Plan</label>
                            <select id="preferredPlan" name="preferredPlan">
                                <option value="">Select a plan</option>
                                <option value="Exam Cram Sessions">Exam Cram Sessions</option>
                                <option value="1-on-1 Tutoring">1-on-1 Tutoring</option>
                            </select>
                        </div>
                        <div>
                            <label for="email">Email <span class="required-star">*</span></label>
                            <input id="email" name="email" type="email" required>
                            <div class="field-error">Valid email is required.</div>
                        </div>
                        <div>
                            <label for="phone">Phone Number <span class="required-star">*</span></label>
                            <input id="phone" name="phone" type="tel" inputmode="numeric" required>
                            <div class="field-error">Enter a valid 10-digit phone number.</div>
                        </div>
                        <div class="full">
                            <label for="contactPreference">Preferred Contact <span class="required-star">*</span></label>
                            <select id="contactPreference" name="contactPreference" required>
                                <option value="">Select preference</option>
                                <option value="Email">Email</option>
                                <option value="Phone">Phone</option>
                            </select>
                            <div class="field-error">Please choose a contact preference.</div>
                        </div>
                        <div class="full">
                            <label for="comments">Additional Comments</label>
                            <textarea id="comments" name="comments" rows="4"></textarea>
                        </div>
                    </div>
                    <div class="form-actions">
                        <button type="button" class="btn btn-secondary" data-close-modal>Cancel</button>
                        <button type="submit" class="btn btn-primary">Submit</button>
                    </div>
                </form>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        enrollModal = document.getElementById('enrollModal');
        enrollForm = document.getElementById('enrollForm');
    }

    function openModal() {
        if (!enrollModal) return;
        enrollModal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeModal() {
        if (!enrollModal) return;
        const form = document.getElementById('enrollForm');
        if (form) {
            form.reset();
            // clear validation states
            form.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
        }
        enrollModal.classList.remove('active');
        document.body.style.overflow = '';
    }

    // Attach to known CTAs
    document.querySelectorAll('.student-hub-link, .floating-consult-btn').forEach(el => {
        el.addEventListener('click', function(e) {
            e.preventDefault();
            openModal();
        });
    });
    // Hero CTAs: Free Consultation or Start Enrollment
    document.querySelectorAll('.hero-buttons .btn').forEach(el => {
        const label = (el.textContent || '').trim().toLowerCase();
        if (label.includes('free consultation') || label.includes('start enrollment')) {
            el.addEventListener('click', function(e) { e.preventDefault(); openModal(); });
        }
    });

    // (Login modal removed)
    // Course Schedule Now
    document.querySelectorAll('.course-card .btn').forEach(el => {
        if (el.textContent.includes('Schedule Now')) {
            el.addEventListener('click', function(e) {
                e.preventDefault();
                // Preselect Preferred Plan based on card header
                const card = el.closest('.course-card');
                const title = card ? (card.querySelector('.course-header h3')?.textContent || '').trim() : '';
                const plan = (title && title.includes('1-on-1')) ? '1-on-1 Tutoring' : (title && title.includes('Exam Cram')) ? 'Exam Cram Sessions' : '';
                const planSelect = document.getElementById('preferredPlan');
                if (planSelect && plan) planSelect.value = plan;
                openModal();
            });
        }
    });

    // Close modal
    document.querySelectorAll('[data-close-modal]').forEach(el => el.addEventListener('click', closeModal));
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

    // Expose enroll opener globally so other scripts (e.g., chatbox) can open it
    try { window.tbpOpenEnroll = openModal; } catch {}

    // Form validation and submission
    function markValidity(field, valid) {
        const wrapper = field.closest('div');
        if (!wrapper) return;
        if (valid) wrapper.classList.remove('invalid');
        else wrapper.classList.add('invalid');
    }

    async function sendForm(payload) {
        try {
            const resp = await fetch('https://formspree.io/f/xpwjwyvw', {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!resp.ok) throw new Error('Network response was not ok');
            return true;
        } catch (e) {
            console.error('Form submit failed', e);
            return false;
        }
    }

    if (enrollForm) {
        enrollForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const fields = ['parentName','studentName','studentGrade','school','subject','email','phone','contactPreference']
                .map(id => document.getElementById(id));
            let allValid = true;
            fields.forEach(f => {
                const valid = !!(f && f.value && f.value.trim().length);
                markValidity(f, valid);
                if (f && f.type === 'email' && valid) {
                    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value);
                    markValidity(f, emailOk);
                    if (!emailOk) allValid = false;
                }
                if (f && f.id === 'phone' && valid) {
                    const digits = (f.value || '').replace(/\D/g,'');
                    const phoneOk = /^\d{10}$/.test(digits);
                    markValidity(f, phoneOk);
                    if (!phoneOk) allValid = false;
                }
                if (!valid) allValid = false;
            });
            if (!allValid) {
                showNotification('Please fill all required fields correctly.', 'error');
                return;
            }
            // Normalize/auto-populate student grade to closest option
            const gradeInput = document.getElementById('studentGrade');
            const rawGrade = (gradeInput && gradeInput.value || '').trim();
            const gradeMap = [
                '5th Grade','6th Grade','7th Grade','8th Grade','9th Grade','10th Grade','11th Grade','12th Grade',
                'Freshman','Sophomore','Junior','Senior'
            ];
            function normalizeGrade(input) {
                if (!input) return '';
                const g = input.toLowerCase();
                // numeric grades
                const num = parseInt(g.replace(/[^0-9]/g,''), 10);
                if (!isNaN(num)) {
                    if (num <= 5) return '5th Grade';
                    if (num >= 12) return '12th Grade';
                    return `${num}th Grade`;
                }
                if (g.includes('fresh')) return 'Freshman';
                if (g.includes('soph')) return 'Sophomore';
                if (g.includes('jun')) return 'Junior';
                if (g.includes('sen')) return 'Senior';
                // try partial match
                const found = gradeMap.find(opt => opt.toLowerCase().startsWith(g));
                return found || input;
            }
            const normalizedGrade = normalizeGrade(rawGrade);
            if (gradeInput && normalizedGrade) gradeInput.value = normalizedGrade;

            // Format phone as +1 (###) ###-#### if 10 digits
            const phoneEl = document.getElementById('phone');
            if (phoneEl) {
                const digits = (phoneEl.value || '').replace(/\D/g,'');
                if (digits.length === 10) {
                    phoneEl.value = `+1 (${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
                }
            }

            const payload = Object.fromEntries(new FormData(enrollForm).entries());
            const ok = await sendForm(payload);
            if (ok) {
                showNotification('🎉 Thank you for enrolling with ThinkBigPrep! We’ll be in touch shortly with next steps.', 'success', 5000);
            } else {
                showNotification('Submission failed. Please try again or email us directly.', 'error');
            }
            closeModal();
            enrollForm.reset();
        });
    }

    // Ensure logo star animation replays on every hover
    const logo = document.querySelector('.logo');
    const star = document.querySelector('.logo .tbp-star');
    if (logo && star) {
        const replayStarAnimation = () => {
            // Reset any running animation and force reflow
            star.style.animation = 'none';
            void star.offsetWidth; // trigger reflow
            // Play hover animation once
            star.style.animation = 'star-pulse 2s ease-in-out 1';
        };
        logo.addEventListener('mouseenter', replayStarAnimation);
        logo.addEventListener('touchstart', replayStarAnimation, { passive: true });
    }
});

// Initialize body opacity
document.body.style.opacity = '0';
document.body.style.transition = 'opacity 0.5s ease';

// AI Curriculum Generator Functionality
document.addEventListener('DOMContentLoaded', function() {
    const curriculumForm = document.getElementById('curriculumForm');
    const curriculumResults = document.getElementById('curriculumResults');
    const curriculumPreview = document.getElementById('curriculumPreview');
    
    if (curriculumForm) {
        curriculumForm.addEventListener('submit', function(e) {
            e.preventDefault();
            generateCurriculum();
        });

        // Toggle fields based on track type
        const trackType = document.getElementById('trackType');
        const stemGroup = document.getElementById('stemSubjectGroup');
        const examGroup = document.getElementById('examTypeGroup');
        const targetScoreGroup = document.getElementById('targetScoreGroup');
        if (trackType) {
            const syncVisibility = () => {
                const isExam = trackType.value === 'sat-act';
                stemGroup.style.display = isExam ? 'none' : 'block';
                examGroup.style.display = isExam ? 'block' : 'none';
                targetScoreGroup.style.display = isExam ? 'block' : 'none';
            };
            trackType.addEventListener('change', syncVisibility);
            syncVisibility();
        }
    }
});

function generateCurriculum() {
    const studentLevel = document.getElementById('studentLevel').value;
    const targetScore = document.getElementById('targetScore').value;
    const studyTime = document.getElementById('studyTime').value;
    const weakAreas = Array.from(document.querySelectorAll('input[type="checkbox"]:checked'))
                          .map(checkbox => checkbox.value);
    
    // Show loading state
    const previewPlaceholder = document.querySelector('.preview-placeholder');
    const curriculumResults = document.getElementById('curriculumResults');
    
    previewPlaceholder.innerHTML = `
        <div class="ai-icon">🤖</div>
        <h4>Generating Your Curriculum...</h4>
        <p>Our AI is analyzing your inputs and creating a personalized study plan</p>
        <div class="loading-spinner"></div>
    `;
    
    // Simulate AI processing time
    setTimeout(() => {
        // Hide placeholder and show results
        previewPlaceholder.style.display = 'none';
        curriculumResults.style.display = 'block';
        
        // Update curriculum based on inputs
        updateCurriculumContent(studentLevel, targetScore, studyTime, weakAreas);
        
        // Add success animation
        curriculumResults.style.animation = 'fadeInUp 0.8s ease-out';
        
        // Scroll to results
        curriculumResults.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 2000);
}

function updateCurriculumContent(level, score, time, areas) {
    // Update timeline content based on inputs
    const timelineItems = document.querySelectorAll('.timeline-item');
    const statNumbers = document.querySelectorAll('.stat-number');
    
    // Adjust timeline based on study time
    if (time >= 15) {
        timelineItems[0].querySelector('.timeline-week').textContent = 'Week 1-2';
        timelineItems[1].querySelector('.timeline-week').textContent = 'Week 3-6';
        timelineItems[2].querySelector('.timeline-week').textContent = 'Week 7-10';
    } else if (time >= 10) {
        timelineItems[0].querySelector('.timeline-week').textContent = 'Week 1-3';
        timelineItems[1].querySelector('.timeline-week').textContent = 'Week 4-8';
        timelineItems[2].querySelector('.timeline-week').textContent = 'Week 9-12';
    } else {
        timelineItems[0].querySelector('.timeline-week').textContent = 'Week 1-4';
        timelineItems[1].querySelector('.timeline-week').textContent = 'Week 5-10';
        timelineItems[2].querySelector('.timeline-week').textContent = 'Week 11-16';
    }
    
    // Update stats based on inputs
    const totalHours = parseInt(time) * 10; // 10 weeks
    const practiceTests = Math.floor(totalHours / 3);
    const successRate = calculateSuccessRate(level, score, areas);
    
    statNumbers[0].textContent = successRate + '%';
    statNumbers[1].textContent = practiceTests;
    statNumbers[2].textContent = totalHours;
    
    // Update timeline content based on weak areas
    updateTimelineContent(areas);
}

function calculateSuccessRate(level, score, areas) {
    let baseRate = 75;
    
    // Adjust based on level
    if (level === 'expert') baseRate += 10;
    else if (level === 'advanced') baseRate += 5;
    else if (level === 'beginner') baseRate -= 5;
    
    // Adjust based on target score
    if (score === '150+') baseRate -= 10;
    else if (score === '120-150') baseRate -= 5;
    else if (score === '80-100') baseRate += 5;
    
    // Adjust based on weak areas
    baseRate -= areas.length * 2;
    
    return Math.max(60, Math.min(95, baseRate));
}

function updateTimelineContent(areas) {
    const timelineContent = document.querySelectorAll('.timeline-content');
    
    // Update first phase
    if (areas.includes('algebra')) {
        timelineContent[0].querySelector('ul').innerHTML = `
            <li>Review algebraic fundamentals</li>
            <li>Practice equation solving</li>
            <li>Take diagnostic assessment</li>
        `;
    }
    
    // Update second phase
    if (areas.includes('geometry')) {
        timelineContent[1].querySelector('ul').innerHTML = `
            <li>Focus on geometric proofs</li>
            <li>Advanced problem types</li>
            <li>Speed training</li>
        `;
    }
    
    // Update third phase
    if (areas.includes('number-theory')) {
        timelineContent[2].querySelector('ul').innerHTML = `
            <li>Full-length practice tests</li>
            <li>Number theory mastery</li>
            <li>Strategy refinement</li>
        `;
    }
}

function downloadCurriculum() {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) {
        alert('PDF library failed to load. Please try again.');
        return;
    }

    const trackType = (document.getElementById('trackType') || { value: 'stem' }).value;
    const stemSubject = (document.getElementById('stemSubject') || { value: 'Algebra' }).value;
    const examType = (document.getElementById('examType') || { value: 'SAT' }).value;
    const studentLevel = (document.getElementById('studentLevel') || { value: 'intermediate' }).value;
    const targetScore = (document.getElementById('targetScore') || { value: '' }).value;
    const studyTime = (document.getElementById('studyTime') || { value: '10' }).value;
    const weakAreas = Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);

    const doc = new jsPDF({ unit: 'pt', format: 'letter' });

    const brand = {
        brown: '#8B4513',
        text: '#222222',
        light: '#f7f5f2'
    };

    const margin = 56;
    let y = margin;

    const title = 'ThinkBigPrep';
    doc.setFillColor(139, 69, 19);
    doc.rect(0, 0, doc.internal.pageSize.getWidth(), 64, 'F');
    doc.setTextColor('#ffffff');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('ThinkBigPrep', margin, 40);
    doc.setFontSize(12);
    doc.text('Personalized Curriculum Plan', margin, 58);

    doc.setTextColor(brand.text);
    y = 92;

    // Student/Plan info box
    const boxH = 120;
    doc.setFillColor(247, 245, 242);
    doc.roundedRect(margin, y, doc.internal.pageSize.getWidth() - margin * 2, boxH, 6, 6, 'F');
    doc.setDrawColor(139, 69, 19);
    doc.setLineWidth(1.5);
    doc.roundedRect(margin, y, doc.internal.pageSize.getWidth() - margin * 2, boxH, 6, 6);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(brand.brown);
    doc.text('PLAN OVERVIEW', margin + 14, y + 22);

    doc.setTextColor(brand.text);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const info = [
        `Track: ${trackType === 'stem' ? 'STEM Subject Mastery' : examType + ' Prep'}`,
        `Focus: ${trackType === 'stem' ? stemSubject + ' — Mastery Goal' : 'Achieve target score ' + (targetScore || '(set)')}`,
        `Level: ${studentLevel}`,
        `Study Time: ${studyTime} hrs/week`,
        `Weak Areas: ${weakAreas.length ? weakAreas.join(', ') : 'N/A'}`
    ];
    info.forEach((t, i) => doc.text(t, margin + 14, y + 44 + i * 16));
    y += boxH + 24;

    // Sections
    const section = (name) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.setTextColor('#3b3b3b');
        doc.text(name, margin, y);
        y += 18;
    };

    const paragraph = (text, width) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(brand.text);
        const lines = doc.splitTextToSize(text, width);
        lines.forEach(line => {
            if (y > doc.internal.pageSize.getHeight() - margin) {
                doc.addPage();
                y = margin;
            }
            doc.text(line, margin, y);
            y += 14;
        });
        y += 6;
    };

    section('Executive Summary');
    paragraph(`This plan is designed to ${trackType === 'stem' ? 'master ' + stemSubject : 'excel on the ' + examType} within your timeframe. The curriculum prioritizes your weakest areas while reinforcing strengths, with weekly milestones and measurable outcomes.`, 480);

    // 8-week table
    section('8-Week Strategic Plan');
    const weeksRows = [
        ['1-2', trackType === 'stem' ? `Foundations of ${stemSubject}` : 'Baseline diagnostic + strategy', 'Daily drills, error log start'],
        ['3-4', trackType === 'stem' ? 'Targeted weak-topic deep dives' : 'Math pacing + Reading/Writing rules', 'Timed sets, walkthroughs'],
        ['5-6', 'Mixed difficulty review', 'Speed training, topic rotations'],
        ['7-8', 'Full mocks + mastery checks', 'Score analysis, refinement'],
    ];
    if (doc.autoTable) {
        doc.autoTable({
            startY: y,
            head: [['Week', 'Objectives', 'Activities']],
            body: weeksRows,
            styles: { font: 'helvetica', fontSize: 9, cellPadding: 6 },
            headStyles: { fillColor: [139,69,19], textColor: 255 },
            theme: 'grid',
            margin: { left: margin, right: margin }
        });
        y = doc.lastAutoTable.finalY + 16;
    } else {
        weeksRows.forEach(r => paragraph(`• Week ${r[0]} - ${r[1]} (${r[2]})`, 480));
    }

    section('Topic Focus');
    const topicFocus = trackType === 'stem'
        ? `${stemSubject}: core theory, problem types, and exam-style applications.`
        : `${examType}: Math strategy, Reading pacing, and Writing grammar, tuned to target score ${targetScore || ''}.`;
    paragraph(topicFocus, 480);

    section('Resources');
    paragraph('Books and platforms: AoPS, Brilliant, Khan Academy, Official SAT/ACT materials, instructor-curated handouts. Practice is organized by difficulty and topic tags.', 480);

    section('Milestones & KPIs');
    paragraph('Weekly quizzes, time-to-solve reductions, accuracy thresholds >85% per topic, and periodic full-length mocks with score targets.', 480);

    // Footer
    const pageH = doc.internal.pageSize.getHeight();
    doc.setDrawColor(139, 69, 19);
    doc.setLineWidth(0.8);
    doc.line(margin, pageH - margin, doc.internal.pageSize.getWidth() - margin, pageH - margin);
    doc.setFontSize(8);
    doc.setTextColor('#777');
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, margin, pageH - margin + 16);
    doc.text('ThinkBigPrep - Confidential', doc.internal.pageSize.getWidth() / 2 - 60, pageH - margin + 16);

    const fileName = `TBP_Curriculum_${trackType === 'stem' ? stemSubject.replace(/\s+/g,'_') : examType}_${new Date().toISOString().slice(0,10)}.pdf`;
    doc.save(fileName);

    showNotification('Curriculum PDF generated.', 'success');
}

function showNotification(message, type, durationMs = 3000) {
    // Use overlay only when explicitly requested
    if (type === 'successOverlay') {
        // Centered success animation with message
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.15);
            z-index: 10000;
        `;

        const card = document.createElement('div');
        card.style.cssText = `
            background: #ffffff;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.22);
            padding: 18px 28px 22px;
            text-align: center;
            max-width: 560px;
            width: calc(100% - 40px);
            animation: fadeInUp 0.3s ease-out;
        `;

        const frame = document.createElement('iframe');
        frame.src = 'https://lottie.host/embed/ec98cc1e-2757-4a41-8d44-89c08e03e508/kzfEdd8Gfs.lottie';
        frame.style.cssText = 'width: 260px; height: 260px; border: none; display: block; margin: 6px auto 0;';
        frame.setAttribute('title', 'Success Animation');
        frame.setAttribute('aria-hidden', 'true');

        const text = document.createElement('div');
        text.textContent = message;
        text.style.cssText = 'margin-top: 10px; color: #1f2937; font-weight: 600; font-size: 16px;';

        card.appendChild(frame);
        card.appendChild(text);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        setTimeout(() => {
            overlay.style.transition = 'opacity 0.3s ease-out';
            overlay.style.opacity = '0';
            setTimeout(() => {
                if (overlay.parentNode) document.body.removeChild(overlay);
            }, 300);
        }, durationMs);

        return;
    }

    // Default top-right toast for non-success
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${(type === 'success' || type === 'successToast') ? '#10b981' : '#ef4444'};
        color: white;
        padding: 16px 24px;
        border-radius: 12px;
        box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
        z-index: 10000;
        animation: slideInRight 0.3s ease-out;
        transform: translateZ(0);
        will-change: transform, opacity;
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => {
            if (notification.parentNode) document.body.removeChild(notification);
        }, 300);
    }, durationMs);
}

// Add CSS animations for notifications
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        0% { transform: translate3d(24px,0,0) scale(0.98); opacity: 0; filter: blur(2px); }
        60% { transform: translate3d(-4px,0,0) scale(1.01); opacity: 1; filter: blur(0); }
        100% { transform: translate3d(0,0,0) scale(1); opacity: 1; }
    }
    
    @keyframes slideOutRight {
        0% { transform: translate3d(0,0,0) scale(1); opacity: 1; }
        100% { transform: translate3d(24px,0,0) scale(0.98); opacity: 0; filter: blur(1px); }
    }
    
    .loading-spinner {
        width: 40px;
        height: 40px;
        border: 4px solid #e2e8f0;
        border-top: 4px solid #3b82f6;
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin: 20px auto 0;
    }
    
    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
`;
document.head.appendChild(style);

// Ensure hero text alternation works on all devices
document.addEventListener('DOMContentLoaded', function() {
    const heroHighlight = document.querySelector('.hero-highlight');
    if (heroHighlight) {
        const texts = ['Algebra', 'Geometry', 'Chemistry', 'Biology', 'Pre-Calculus', 'Physics', 'Calculus'];
        let currentIndex = 0;
        let intervalId = null;
        
        // Function to update the text with fade effect
        function updateText() {
            // Fade out
            heroHighlight.classList.add('fade-out');
            
            // Change text after fade out
            setTimeout(() => {
                heroHighlight.textContent = texts[currentIndex];
                currentIndex = (currentIndex + 1) % texts.length;
                
                // Fade in
                heroHighlight.classList.remove('fade-out');
            }, 250);
        }
        
        // Start the interval
        function startInterval() {
            if (!intervalId) {
                intervalId = setInterval(updateText, 3000);
            }
        }
        
        // Stop the interval
        function stopInterval() {
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
            }
        }
        
        // Initial text update
        updateText();
        
        // Start the interval
        startInterval();
        
        // Ensure it works on mobile by restarting on visibility change
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible') {
                startInterval();
            } else {
                stopInterval();
            }
        });
        
        // Restart on window focus (mobile debugging)
        window.addEventListener('focus', startInterval);
        
        // Force update on touch (mobile debugging)
        document.addEventListener('touchstart', function() {
            if (!intervalId) {
                startInterval();
            }
        });
    }
});
