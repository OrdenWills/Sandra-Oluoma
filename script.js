document.addEventListener('DOMContentLoaded', () => {

    // Prevent transitions on initial load to fix the "reloading mid-scroll" glitch
    document.body.classList.add('preload');

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
            
            if (name && email) {
                const btn = waitlistForm.querySelector('button');
                const originalText = btn.textContent;
                btn.textContent = 'YOU\'RE ON THE LIST!';
                btn.style.backgroundColor = '#28a745';
                
                waitlistForm.reset();
                
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

    if (localStorage.getItem('theme') === 'light') {
        enableLightMode();
    }

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

        mobileNavItems.forEach(item => {
            item.addEventListener('click', () => {
                mobileModal.classList.remove('active');
                const icon = mobileMenuBtn.querySelector('i');
                icon.classList.remove('fa-xmark');
                icon.classList.add('fa-grip');
            });
        });

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

    // Bundled scroll logic into a function
    function updateNavState() {
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
            if (scrollY >= (sectionTop - 200)) { 
                current = section.getAttribute('id');
            }
        });

        // Highlight both desktop and mobile nav items cleanly
        document.querySelectorAll('.nav-links li a, .mobile-nav-item').forEach(el => {
            el.classList.remove('active');
            if (current && el.getAttribute('href').includes(current)) {
                el.classList.add('active');
            }
        });
    }

    // 1. Call it immediately on load to apply correct state BEFORE user scrolls
    updateNavState();
    
    // 2. Remove the preload class slightly after load to re-enable smooth transitions
    setTimeout(() => {
        document.body.classList.remove('preload');
    }, 150);

    // 3. Attach it to the scroll event listener
    window.addEventListener('scroll', updateNavState);
    
    // --- SMOOTH SCROLL ---
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            document.querySelector(this.getAttribute('href')).scrollIntoView({
                behavior: 'smooth'
            });
        });
    });

    // --- TRANSFORMATION CAROUSEL ---
    const tsSlider = document.getElementById('transformation-slider');
    const tsTrack = tsSlider.querySelector('.transformation-track');
    const tsSlides = Array.from(tsSlider.querySelectorAll('.transformation-slide'));
    const tsPrev = tsSlider.querySelector('.ts-prev');
    const tsNext = tsSlider.querySelector('.ts-next');
    const tsDotsWrap = tsSlider.parentElement.querySelector('.ts-dots');
    const TS_INTERVAL = 4000;
    let currentSlide = 0;
    let tsAutoTimer;

    tsSlides.forEach((_, index) => {
        const dot = document.createElement('button');
        dot.classList.add('ts-dot');
        dot.setAttribute('aria-label', 'Go to transformation ' + (index + 1));
        dot.addEventListener('click', () => goToSlide(index, true));
        tsDotsWrap.appendChild(dot);
    });

    const tsDots = Array.from(tsDotsWrap.querySelectorAll('.ts-dot'));

    function goToSlide(index, resetTimer) {
        currentSlide = (index + tsSlides.length) % tsSlides.length;
        tsTrack.style.transform = `translateX(-${currentSlide * 100}%)`;
        tsDots.forEach((dot, i) => dot.classList.toggle('active', i === currentSlide));
        if (resetTimer) restartAuto();
    }

    function startAuto() {
        clearInterval(tsAutoTimer);
        tsAutoTimer = setInterval(() => goToSlide(currentSlide + 1, false), TS_INTERVAL);
    }

    function restartAuto() {
        clearInterval(tsAutoTimer);
        startAuto();
    }

    tsPrev.addEventListener('click', () => goToSlide(currentSlide - 1, true));
    tsNext.addEventListener('click', () => goToSlide(currentSlide + 1, true));

    tsSlider.addEventListener('pointerenter', () => clearInterval(tsAutoTimer));
    tsSlider.addEventListener('pointerleave', startAuto);

    goToSlide(0, false);
    startAuto();
});