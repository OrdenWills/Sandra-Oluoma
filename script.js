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
        waitlistForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const name = document.getElementById('name').value;
            const email = document.getElementById('email').value;

            if (!name || !email) return;

            const btn = waitlistForm.querySelector('button');
            const originalText = btn.textContent;
            btn.disabled = true;

            try {
                const response = await fetch(waitlistForm.action.replace('/sclems600@gmail.com', '/ajax/sclems600@gmail.com'), {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json'
                    },
                    body: new FormData(waitlistForm)
                });

                if (!response.ok) throw new Error('Submit failed');

                btn.textContent = "YOU'RE ON THE LIST!";
                btn.style.backgroundColor = '#28a745';
                waitlistForm.reset();

                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.style.backgroundColor = '';
                    btn.disabled = false;
                }, 3000);
            } catch (err) {
                // Fallback: native form POST (works even where fetch is CORS-blocked)
                waitlistForm.action = 'https://formsubmit.co/sclems600@gmail.com';
                waitlistForm.method = 'POST';
                waitlistForm.submit();
            }
        });
    }

    // --- LIGHT/DARK MODE LOGIC ---
    const themeBtns = document.querySelectorAll('.theme-btn:not(#mobile-menu-btn):not(.mobile-call-btn)');
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

    // --- GRAPHICS SHOWCASE SAMPLES ---
    const graphicCards = document.querySelectorAll('.graphic-card[data-samples]');
    const SAMPLE_LIMIT = 12;
    const SAMPLE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'];

    function probeImage(src) {
        return new Promise(resolve => {
            const probe = new Image();
            probe.onload = () => resolve(true);
            probe.onerror = () => resolve(false);
            probe.src = src;
        });
    }

    async function getSampleFiles(prefix) {
        const files = [];

        for (let i = 1; i <= SAMPLE_LIMIT; i++) {
            let found = '';

            for (const ext of SAMPLE_EXTENSIONS) {
                const src = `assets/${prefix}${i}.${ext}`;
                if (await probeImage(src)) {
                    found = src;
                    break;
                }
            }

            if (!found) break;
            files.push(found);
        }

        return files;
    }

    function positionSamples(card) {
        const samples = card.querySelectorAll('.graphic-sample');
        if (!samples.length) return;

        const cardStyles = getComputedStyle(card);
        const orbitX = parseFloat(cardStyles.getPropertyValue('--orbit-x')) || 0.5;
        const orbitY = parseFloat(cardStyles.getPropertyValue('--orbit-y')) || 0.45;
        const radiusX = Math.max(80, card.clientWidth * orbitX);
        const radiusY = Math.max(60, card.clientHeight * orbitY);
        const step = 360 / samples.length;
        const start = -90 - step / 2;

        samples.forEach((sample, i) => {
            const angle = ((start + step * i) * Math.PI) / 180;

            sample.style.setProperty('--dx', `${(Math.cos(angle) * radiusX).toFixed(1)}px`);
            sample.style.setProperty('--dy', `${(Math.sin(angle) * radiusY).toFixed(1)}px`);
            sample.style.setProperty('--rot', `${(Math.cos(angle) * 9).toFixed(1)}deg`);
            sample.style.setProperty('--delay', `${i * 40}ms`);
        });
    }

    function closeGraphicCards(except) {
        graphicCards.forEach(card => {
            if (card !== except) card.classList.remove('is-open');
        });
    }

    function toggleGraphicCard(card) {
        const shouldOpen = !card.classList.contains('is-open');
        closeGraphicCards(card);
        card.classList.toggle('is-open', shouldOpen);
    }

    async function initGraphicShowcase() {
        for (const card of graphicCards) {
            const layer = card.querySelector('.graphic-samples');
            if (!layer) continue;

            const explicitFiles = (card.dataset.sampleFiles || '')
                .split(',')
                .map(file => file.trim())
                .filter(Boolean);
            const files = explicitFiles.length ? explicitFiles : await getSampleFiles(card.dataset.samples);

            if (!files.length) {
                card.classList.add('no-samples');
                continue;
            }

            files.forEach(src => {
                const img = document.createElement('img');
                img.className = 'graphic-sample';
                img.src = src;
                img.alt = '';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.draggable = false;
                layer.appendChild(img);
            });

            positionSamples(card);

            if ('ResizeObserver' in window) {
                const observer = new ResizeObserver(() => positionSamples(card));
                observer.observe(card);
            }

            card.addEventListener('click', event => {
                if (event.target.closest('a, .tip-icon')) return;
                toggleGraphicCard(card);
            });

            card.addEventListener('keydown', event => {
                if (event.target !== card) return;
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleGraphicCard(card);
                }
            });
        }

        document.addEventListener('click', event => {
            if (!event.target.closest('.graphic-card')) closeGraphicCards();
        });
    }

    // --- PRICING STACKED DECK SCROLL LOGIC ---
    function initPricingDeck() {
        const track = document.getElementById('pricing-track');
        const deck = document.getElementById('pricing-deck');
        if (!track || !deck) return;

        const cards = Array.from(deck.querySelectorAll('.graphic-card'));
        const total = cards.length;
        if (!total) return;

        const prevBtn = document.getElementById('deck-prev');
        const nextBtn = document.getElementById('deck-next');
        const dotsWrap = document.getElementById('deck-dots');
        const counter = document.getElementById('deck-counter');

        const ENTRY_PAD = 0.05;
        const EXIT_PAD = 0.05;
        const DWELL = 0.18;

        let activeIndex = -1;
        let ticking = false;

        track.style.setProperty('--deck-count', total);

        if (dotsWrap) {
            cards.forEach((card, index) => {
                const dot = document.createElement('button');
                dot.type = 'button';
                dot.className = 'deck-dot';
                dot.setAttribute('aria-label', `Go to pricing card ${index + 1}`);
                dot.addEventListener('click', () => scrollToCard(index));
                dotsWrap.appendChild(dot);
            });
        }

        const dots = dotsWrap ? Array.from(dotsWrap.children) : [];

        const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

        function getStep() {
            const raw = getComputedStyle(track).getPropertyValue('--deck-step').trim();
            if (raw.endsWith('vh')) {
                return window.innerHeight * parseFloat(raw) / 100;
            }
            const parsed = parseFloat(raw);
            return Number.isFinite(parsed) ? parsed : window.innerHeight * 0.46;
        }

        function scrollToCard(index) {
            const target = clamp(index, 0, total - 1);
            const trackTop = window.scrollY + track.getBoundingClientRect().top;
            window.scrollTo({
                top: trackTop + getStep() * target,
                behavior: 'smooth'
            });
        }

        function setActive(index) {
            if (index === activeIndex) return;
            activeIndex = index;
            closeGraphicCards();
            dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
            if (counter) {
                counter.textContent = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
            }
            if (prevBtn) prevBtn.disabled = index === 0;
            if (nextBtn) nextBtn.disabled = index === total - 1;
        }

        function render() {
            ticking = false;

            const rect = track.getBoundingClientRect();
            const scrollable = track.offsetHeight - window.innerHeight;
            if (scrollable <= 0) return;

            const progress = clamp(-rect.top / scrollable, 0, 1);
            const position = progress * (total - 1);
            const segment = Math.min(Math.floor(position), total - 2);
            const local = clamp(position - segment, 0, 1);

            const transitionStart = DWELL + ENTRY_PAD;
            const transitionEnd = 1 - DWELL - EXIT_PAD;
            const t = clamp((local - transitionStart) / (transitionEnd - transitionStart), 0, 1);

            cards.forEach((card, index) => {
                let y = 100;
                let opacity = 0;
                let scale = 0.96;
                let z = 1;

                if (index === segment) {
                    y = -t * 100;
                    opacity = 1 - t;
                    scale = 1 - t * 0.04;
                    z = 2;
                } else if (index === segment + 1) {
                    y = (1 - t) * 100;
                    opacity = t;
                    scale = 0.96 + t * 0.04;
                    z = 3;
                } else if (index < segment) {
                    y = -100;
                }

                card.style.transform = `translate3d(0, ${y}%, 0) scale(${scale})`;
                card.style.opacity = opacity;
                card.style.zIndex = z;
                card.style.pointerEvents = opacity > 0.5 ? 'auto' : 'none';
                card.setAttribute('aria-hidden', opacity < 0.5 ? 'true' : 'false');
            });

            setActive(t < 0.5 ? segment : Math.min(segment + 1, total - 1));
        }

        function onScroll() {
            if (!ticking) {
                ticking = true;
                requestAnimationFrame(render);
            }
        }

        if (prevBtn) prevBtn.addEventListener('click', () => scrollToCard(activeIndex - 1));
        if (nextBtn) nextBtn.addEventListener('click', () => scrollToCard(activeIndex + 1));

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        render();
    }

    initGraphicShowcase();
    initPricingDeck();

    window.addEventListener('resize', () => {
        graphicCards.forEach(positionSamples);
    });

    // --- FOOTER YEAR ---
    const footerYear = document.getElementById('year');
    if (footerYear) {
        footerYear.textContent = new Date().getFullYear();
    }
});