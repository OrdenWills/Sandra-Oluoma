document.addEventListener('DOMContentLoaded', () => {

    // --- PRICING TOGGLE LOGIC ---
    const pricingCards = document.querySelectorAll('.pricing-card');
    const pricingToggles = document.querySelectorAll('.pricing-toggle');

    // Open "Headline Only" and "Best Value" cards by default
    pricingCards.forEach(card => {
        const title = card.querySelector('h3').textContent.toLowerCase();
        if (title.includes('headline only') || card.classList.contains('best-value')) {
            card.classList.add('open');
            const toggle = card.querySelector('.pricing-toggle');
            if (toggle && toggle.textContent.includes('to close')) {
                // keep "Tap to close" for headline only, "Select to close" for best value
            }
        }
    });

    // Toggle on click
    pricingToggles.forEach(toggle => {
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = toggle.closest('.pricing-card');
            card.classList.toggle('open');
        });
    });

    // Toggle on hover (desktop)
    pricingCards.forEach(card => {
        card.addEventListener('mouseenter', () => {
            if (window.innerWidth > 768) {
                card.classList.add('open');
            }
        });
        card.addEventListener('mouseleave', () => {
            if (window.innerWidth > 768 && !card.classList.contains('best-value') && !card.querySelector('h3').textContent.toLowerCase().includes('headline only')) {
                card.classList.remove('open');
            }
        });
    });

    // --- FAQ ACCORDION LOGIC ---
    const faqItems = document.querySelectorAll('.faq-item');
    
    faqItems.forEach(item => {
        const question = item.querySelector('.faq-question');
        
        question.addEventListener('click', () => {
            const isActive = item.classList.contains('active');
            
            // Close all FAQ items
            faqItems.forEach(faq => {
                faq.classList.remove('active');
            });
            
            // Toggle the clicked item
            if (!isActive) {
                item.classList.add('active');
            }
        });
    });

    // --- WAITLIST FORM LOGIC ---
    const waitlistForm = document.getElementById('waitlist-form');
    
    if (waitlistForm) {
        waitlistForm.addEventListener('submit', (e) => {
            e.preventDefault();
            
            const name = document.getElementById('name').value;
            const email = document.getElementById('email').value;
            
            // Simple validation
            if (name && email) {
                // Show success message
                const btn = waitlistForm.querySelector('button');
                const originalText = btn.textContent;
                btn.textContent = 'YOU\'RE ON THE LIST!';
                btn.style.backgroundColor = '#28a745';
                
                // Reset form
                waitlistForm.reset();
                
                // Reset button after 3 seconds
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.style.backgroundColor = '';
                }, 3000);
            }
        });
    }

    // --- LIGHT/DARK MODE LOGIC ---
    const themeBtns = document.querySelectorAll('.theme-btn:not(#mobile-menu-btn)');
    const body = document.body;

    // Check for saved preference and initialize
    if (localStorage.getItem('theme') === 'light') {
        enableLightMode();
    }

    // Add event listeners to ALL theme toggle buttons
    themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (body.classList.contains('light-mode')) {
                disableLightMode();
            } else {
                enableLightMode();
            }
        });
    });

    function enableLightMode() {
        body.classList.add('light-mode');
        themeBtns.forEach(btn => {
            const icon = btn.querySelector('i');
            icon.classList.remove('fa-sun');
            icon.classList.add('fa-moon');
        });
        localStorage.setItem('theme', 'light');
    }

    function disableLightMode() {
        body.classList.remove('light-mode');
        themeBtns.forEach(btn => {
            const icon = btn.querySelector('i');
            icon.classList.remove('fa-moon');
            icon.classList.add('fa-sun');
        });
        localStorage.setItem('theme', 'dark');
    }

    // --- MOBILE MENU LOGIC ---
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const mobileModal = document.querySelector('.mobile-menu-modal');
    const mobileNavItems = document.querySelectorAll('.mobile-nav-item');

    if (mobileMenuBtn && mobileModal) {
        // Toggle Modal
        mobileMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            mobileModal.classList.toggle('active');

            const icon = mobileMenuBtn.querySelector('i');
            if (mobileModal.classList.contains('active')) {
                icon.classList.remove('fa-grip');
                icon.classList.add('fa-xmark');
            } else {
                icon.classList.remove('fa-xmark');
                icon.classList.add('fa-grip');
            }
        });

        // Close on Link Click
        mobileNavItems.forEach(item => {
            item.addEventListener('click', () => {
                mobileModal.classList.remove('active');
                const icon = mobileMenuBtn.querySelector('i');
                icon.classList.remove('fa-xmark');
                icon.classList.add('fa-grip');
            });
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (mobileModal.classList.contains('active') &&
                !mobileModal.contains(e.target) &&
                e.target !== mobileMenuBtn &&
                !mobileMenuBtn.contains(e.target)) {

                mobileModal.classList.remove('active');
                const icon = mobileMenuBtn.querySelector('i');
                icon.classList.remove('fa-xmark');
                icon.classList.add('fa-grip');
            }
        });
    }

    // --- NAVBAR SCROLL EFFECT ---
    const navbar = document.querySelector('.glass-nav');
    const aboutSection = document.getElementById('about');

    window.addEventListener('scroll', () => {
        const scrollY = window.scrollY;

        // Navbar glass effect
        if (scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }

        // HERO IMAGE TRANSITION LOGIC
        if (aboutSection && scrollY >= (aboutSection.offsetTop - 300)) {
            navbar.classList.add('reveal-profile');
        } else {
            navbar.classList.remove('reveal-profile');
        }

        // Active link highlighting
        let current = '';
        const sections = document.querySelectorAll('section');

        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.clientHeight;
            if (scrollY >= (sectionTop - 200)) { 
                current = section.getAttribute('id');
            }
        });

        // Highlight desktop nav links
        document.querySelectorAll('.nav-links li a').forEach(a => {
            a.classList.remove('active');
            if (a.getAttribute('href').includes(current)) {
                a.classList.add('active');
            }
        });

        // Highlight mobile nav items
        document.querySelectorAll('.mobile-nav-item').forEach(item => {
            item.classList.remove('active');
            if (item.getAttribute('href').includes(current)) {
                item.classList.add('active');
            }
        });
    });
    
    // --- SMOOTH SCROLL ---
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            document.querySelector(this.getAttribute('href')).scrollIntoView({
                behavior: 'smooth'
            });
        });
    });
});
