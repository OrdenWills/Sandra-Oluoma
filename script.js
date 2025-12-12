document.addEventListener('DOMContentLoaded', () => {

    // --- TAB LOGIC ---
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.content-view');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const target = tab.getAttribute('data-target');
            contents.forEach(content => {
                content.classList.remove('active');
            });

            document.getElementById(target).classList.add('active');
        });
    });

    // --- LIGHT/DARK MODE LOGIC ---
    // Select all specific theme toggle buttons (excluding other buttons that might use the class for styling)
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
        // Update all icons
        themeBtns.forEach(btn => {
            const icon = btn.querySelector('i');
            icon.classList.remove('fa-sun');
            icon.classList.add('fa-moon');
        });
        localStorage.setItem('theme', 'light');
    }

    function disableLightMode() {
        body.classList.remove('light-mode');
        // Update all icons
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
            e.stopPropagation(); // Prevent immediate closing if clicking body
            mobileModal.classList.toggle('active');

            // Optional: Toggle icon
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
                // Reset icon
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
                // Reset icon
                const icon = mobileMenuBtn.querySelector('i');
                icon.classList.remove('fa-xmark');
                icon.classList.add('fa-grip');
            }
        });
    }

    // --- NAVBAR SCROLL EFFECT ---
    const navbar = document.querySelector('.glass-nav');

    window.addEventListener('scroll', () => {
        // Navbar glass effect
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }

        // Active link highlighting
        let current = '';
        const sections = document.querySelectorAll('section');

        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.clientHeight;
            if (scrollY >= (sectionTop - 200)) { // Offset for header/visual comfort
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