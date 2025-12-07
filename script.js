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
    const themeBtn = document.getElementById('theme-toggle');
    const themeIcon = themeBtn.querySelector('i');
    const body = document.body;

    // Check for saved preference
    if (localStorage.getItem('theme') === 'light') {
        enableLightMode();
    }

    themeBtn.addEventListener('click', () => {
        if (body.classList.contains('light-mode')) {
            disableLightMode();
        } else {
            enableLightMode();
        }
    });

    function enableLightMode() {
        body.classList.add('light-mode');
        themeIcon.classList.remove('fa-sun');
        themeIcon.classList.add('fa-moon'); // Change to moon icon
        localStorage.setItem('theme', 'light');
    }

    function disableLightMode() {
        body.classList.remove('light-mode');
        themeIcon.classList.remove('fa-moon');
        themeIcon.classList.add('fa-sun'); // Change back to sun icon
        localStorage.setItem('theme', 'dark');
    }

    // --- NAVBAR SCROLL EFFECT ---
    const navbar = document.querySelector('.glass-nav');

    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
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