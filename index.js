// AMC Academy Website JavaScript

// Mobile menu toggle functionality
function toggleMobileMenu() {
    const mobileMenu = document.getElementById('mobile-menu');
    if (mobileMenu.style.display === 'block') {
        mobileMenu.style.display = 'none';
    } else {
        mobileMenu.style.display = 'block';
    }
}

// Smooth scrolling for navigation links
document.addEventListener('DOMContentLoaded', function() {
    // Get all navigation links
    const navLinks = document.querySelectorAll('a[href^="#"]');
    
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('href');
            const targetSection = document.querySelector(targetId);
            
            if (targetSection) {
                // Close mobile menu if open
                const mobileMenu = document.getElementById('mobile-menu');
                if (mobileMenu.style.display === 'block') {
                    mobileMenu.style.display = 'none';
                }
                
                // Smooth scroll to target section
                const headerHeight = document.querySelector('.header').offsetHeight;
                const targetPosition = targetSection.offsetTop - headerHeight;
                
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
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

// Course scheduling functionality
document.addEventListener('DOMContentLoaded', function() {
    const scheduleButtons = document.querySelectorAll('button');
    
    scheduleButtons.forEach(button => {
        if (button.textContent.includes('Schedule Now')) {
            button.addEventListener('click', function() {
                // You can add actual scheduling logic here
                alert('Thank you for your interest! Please contact us at 778-533-4028 or info@amcacademy.ca to schedule your classes.');
            });
        }
    });
});

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
    // Create a simple PDF-like download
    const curriculumData = {
        studentLevel: document.getElementById('studentLevel').value,
        targetScore: document.getElementById('targetScore').value,
        studyTime: document.getElementById('studyTime').value,
        weakAreas: Array.from(document.querySelectorAll('input[type="checkbox"]:checked'))
                       .map(checkbox => checkbox.value),
        generatedDate: new Date().toLocaleDateString()
    };
    
    // Create download link
    const dataStr = JSON.stringify(curriculumData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = 'amc-curriculum-plan.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    // Show success message
    showNotification('Curriculum downloaded successfully!', 'success');
}

function showNotification(message, type) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#10b981' : '#ef4444'};
        color: white;
        padding: 16px 24px;
        border-radius: 12px;
        box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
        z-index: 10000;
        animation: slideInRight 0.3s ease-out;
    `;
    
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}

// Add CSS animations for notifications
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOutRight {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
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

// Ensure hero text stays stable
document.addEventListener('DOMContentLoaded', function() {
    const heroHighlight = document.querySelector('.hero-highlight');
    if (heroHighlight) {
        const texts = ['Algebra', 'Geometry', 'Chemistry', 'Biology', 'Pre-Calculus', 'Physics', 'Calculus'];
        let currentIndex = 0;
        
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
        
        // Update text every 3 seconds
        setInterval(updateText, 3000);
        
        // Initial text
        updateText();
    }
});
