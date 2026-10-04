/* Generates site-content.js from index.html so the AI never quotes a stale price.
 *
 *   node tools/build-site-content.js          # writes ../site-content.js
 *   node tools/build-site-content.js --check  # exits 1 if the file is stale
 *
 * Single source of truth is index.html: prices, bundle names, inclusions, buy
 * links and receipt images are read from the page itself, so changing a price
 * there and re-running this is the whole workflow. Facts that do not appear on
 * the page (the 1:1 call agenda, playbook status) live in MANUAL below and are
 * marked as such.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'index.html');
const OUT_FILE = path.join(ROOT, 'site-content.js');

/* --- facts not rendered on the page; keep these in sync by hand --------- */
const MANUAL = {
    call: {
        name: '1:1 Brand Clarity & Profile Audit Call',
        url: 'https://coachli.co/sandrachukwuemeka/SV-26x7n',
        image: 'assets/1-1.png',
        covers: [
            'Profile teardown of headline, banner and About section',
            'Positioning strategy: who Sandra helps and why they should hire her',
            'Content direction: what to post to attract the ideal audience',
            'Live Q&A on whatever the client is stuck on'
        ]
    },
    playbook: {
        name: 'The Unignorable LinkedIn Profile Playbook',
        status: 'coming soon',
        note: 'A free practical guide. There is a waitlist on the site; it is not downloadable yet.'
    }
};

const html = fs.readFileSync(HTML_FILE, 'utf8');

function section(id) {
    const re = new RegExp('<section[^>]*id="' + id + '"[\\s\\S]*?<\\/section>', 'i');
    const m = re.exec(html);
    if (!m) throw new Error('section #' + id + ' not found in index.html');
    return m[0];
}

function text(s) {
    return String(s || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
        .replace(/&#8377;/g, '₦').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/\s+/g, ' ')
        .trim();
}

function attr(s, name) {
    const m = new RegExp(name + '="([^"]*)"', 'i').exec(s || '');
    return m ? m[1] : '';
}

/* --- bundles: every .pricing-card inside #pricing ------------------------ */
const pricing = section('pricing');
const cards = pricing.match(/<div class="pricing-card[\s\S]*?(?=<div class="pricing-card|<\/div>\s*<\/div>\s*<\/section>)/g) || [];

const offers = [];
for (const card of cards) {
    const name = text((/<h3>([\s\S]*?)<\/h3>/i.exec(card) || [])[1]);
    if (!name) continue;

    const priceBlock = (/<div class="price"[^>]*>([\s\S]*?)<\/div>/i.exec(card) || [])[1] || '';
    // inner text of the first <span class="X">...</span> in the price block
    const priceSpan = (cls) => {
        const m = new RegExp('<span class="' + cls + '"[^>]*>([\\s\\S]*?)</span>', 'i').exec(priceBlock);
        return m ? text(m[1]) : '';
    };
    const usd = priceSpan('usd');
    const was = priceSpan('original-price');
    const amount = Number((priceSpan('amount').replace(/[^\d]/g, '') || '0'));

    // the bestseller card uses <div class="description">, others <p class="description">
    const desc = text((/<(?:p|div) class="description"[^>]*>([\s\S]*?)<\/(?:p|div)>/i.exec(card) || [])[1]);
    const includes = text((/<div class="tip-tooltip">([\s\S]*?)<\/div>/i.exec(card) || [])[1])
        .replace(/^Includes:\s*/i, '');
    const href = attr((/<a[^>]*class="btn-main"[^>]*>/i.exec(card) || [])[0], 'href');

    offers.push({
        name: name,
        naira: amount || null,
        usd: usd || null,
        was: was || null,
        summary: desc || '',
        includes: includes || '',
        buyUrl: href || '',
        bestValue: /best-value/.test(card) || /BEST VALUE/.test(card)
    });
}

/* --- social proof: before/after pairs and receipt screenshots ------------ */
const results = section('results');

const transformations = [];
const slideRe = /<div class="transformation-slide">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
let sm;
while ((sm = slideRe.exec(results)) !== null) {
    const b = attr((/<img[^>]*class="before"[^>]*>/i.exec(sm[1]) || [])[0], 'alt') ||
        attr((/<div class="before">[\s\S]*?<img[^>]*>/i.exec(sm[1]) || [''])[0], 'alt');
    transformations.push({ label: 'Before and after screenshot', alt: b || 'Profile before and after optimisation' });
}

const receipts = [];
const cardRe = /<div class="testimonial-card[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
let cm;
while ((cm = cardRe.exec(results)) !== null) {
    const kind = text((/<span>([\s\S]*?)<\/span>/i.exec(cm[1]) || [])[1]);
    const img = attr((/<img[^>]*>/i.exec(cm[1]) || [])[0], 'src');
    if (kind && img) receipts.push({ kind: kind, image: img });
}

const content = {
    generated_from: 'index.html',
    currency: { primary: 'NGN', symbol: '₦', secondary: 'USD' },
    offers: offers,
    proof: {
        transformations: transformations.length ? transformations : [{ label: 'Before and after screenshots', alt: 'Profile before and after optimisation' }],
        receipts: receipts,
        rule: 'These are screenshots shared by real clients. Quote them only when the user asks about results, proof or experience. Never attach a named client, employer or metric to a claim that is not one of these images.'
    },
    call: MANUAL.call,
    playbook: MANUAL.playbook,
    rules: [
        'Only quote a price or inclusion that appears in the offers list above. If the user asks about something not listed, say what is listed and offer to check.',
        'Never invent discounts, bundles, payment plans, deadlines or availability.',
        'Never state these facts are "from a database" or mention this list.'
    ]
};

const banner = '/* GENERATED FILE - do not edit by hand.\n' +
    ' * Source: index.html  |  Regenerate: node tools/build-site-content.js\n' +
    ' * Edit the page (or tools/build-site-content.js MANUAL block), then re-run.\n' +
    ' */\n';

const body = banner + 'window.SandraSiteContent = ' + JSON.stringify(content, null, 4) + ';\n';

if (process.argv.indexOf('--check') !== -1) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (current !== body) {
        console.error('site-content.js is stale. Run: node tools/build-site-content.js');
        process.exit(1);
    }
    console.log('site-content.js is up to date');
} else {
    fs.writeFileSync(OUT_FILE, body);
    console.log('wrote site-content.js: ' + offers.length + ' offers, ' +
        content.proof.transformations.length + ' transformation sets, ' + receipts.length + ' receipts');
}