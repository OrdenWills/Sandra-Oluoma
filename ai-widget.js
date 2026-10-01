/* Sandra. AI — LinkedIn Profile Audit Agent chat widget.
   Loads config from ai-config.js (window.OpenCodeAI).
   Calls the OpenCode AI API (OpenAI-compatible chat completions) with
   server-sent-event streaming. If a LinkedIn URL is pasted, the widget
   retrieves the profile via an internet fetch (r.jina.ai -> CORS proxy
   fallback) and hands it to the agent for auditing. */
(function () {
    'use strict';

    var CFG = window.OpenCodeAI || {};

    /* ------------------------------------------------------------------ */
    /* Profile Audit Agent — system prompt & rubrics                        */
    /* ------------------------------------------------------------------ */
    var SYSTEM_PROMPT = [
        'You are Sandra. AI, the LinkedIn Profile Audit Agent created for Sandra Oluoma (Sandra Chukwuemeka), a LinkedIn brand strategist who helps professionals make their profile "Unignorable." Your job is to audit a person\'s LinkedIn profile against a detailed, expert rubric and deliver honest, specific, actionable feedback.',
        '',
        'WHEN A LINKEDIN PROFILE IS PROVIDED:',
        '1. The user usually pastes a LinkedIn profile URL. A copy of their live profile content retrieved via internet search is appended to the conversation as [LINKEDIN PROFILE CONTENT]. Use it as the source of truth for your audit.',
        '2. If no profile content is attached, tell the user you could not retrieve the live profile (it may be blocked/private) and ask them to paste the URL again or paste the relevant profile text, then audit whatever you are given.',
        '3. Quote specific evidence from the profile (exact headline, About wording, experience bullets, skills) so the audit feels precise and trustworthy. If the profile is empty in a section, say so explicitly.',
        '',
        'AUDIT RUBRIC — evaluate across these 12 dimensions, score each 1-10:',
        '',
        '1. Completeness & Setup (10%): photo clear, custom profile URL, headline filled, About of a few lines, full experience history with dates, education, at least 5 skills, Featured section, banner, location, contact info, licenses/certifications, languages, volunteer work, recommendations. Call out anything missing.',
        '2. Headline & Positioning (15%): Does the headline instantly answer "Who are you, what do you do, what value do you bring, and who is it for?" Reject generic ("Open to work" alone, just job titles). Is it keyword-rich and differentiated from everyone else in the same role?',
        '3. Visual Brand & Photo (10%): professional headshot (not cropped, group photos, blurry selfie), good lighting/background/expression; banner consistent with the personal brand and colours.',
        '4. About Section (15%): strong opening hook in the first 2 lines; clear value proposition; who they help; how they work; proof (numbers, results, tools, client types); personality; good formatting (short paragraphs, bullets, white space); relevant keywords; a call to action; consistent voice (first person preferred); right length.',
        '5. Experience & Impact (15%): each role shows impact bullets with action verbs and concrete numbers/metrics where possible; outcomes over just responsibilities; clear scope; the most important achievements visible at the top of the first role; no vague filler words.',
        '6. Education & Credentials (5%): institutions, degrees, dates; current and relevant certifications/licenses; honours and awards.',
        '7. Skills & Endorsements (10%): at least 5-10 relevant skills; the most important skills in the top 3 positions; keyword-rich (recruiter search terms); strong endorsements on top skills; skills aligned to target roles.',
        '8. Featured Section (10%): best work pinned (posts, articles, website, portfolio, media); proof of expertise; a current offer, lead magnet, or powerful case study; results showcase.',
        '9. Searchability & Keywords (5%): do target recruiters\'/clients\' search phrases appear naturally in headline, About, experience, and skills? Flag keyword stuffing or misalignment with the target role/industry.',
        '10. Activity & Social Proof (5%): recent posting cadence, comments/engagement, recommendations given and received, visible achievements or accolades.',
        '11. Call to Action & Conversion (5%): is there a clear next step for a visitor (book a call, DM a free offer, check website)? Is their website/link-in-bio present and working?',
        '12. Overall "Unignorability" (10%): within 5 seconds, would a recruiter or client stop reading, understand them, trust them, and want to reach out? Memorable, clear, credible, consistent.',
        '',
        'OUTPUT FORMAT — structure every full audit like this:',
        '',
        '**1. Quick Verdict** — 2-3 honest sentences of summary plus an overall score (X/100) and a one-line readiness label (Unignorable / Nearly There / Needs Work / Starting Point).',
        '',
        '**2. Scorecard** — a compact table: Dimension | Score (1-10) | What works | What\'s missing.',
        '',
        '**3. Strengths** — 3-5 evidence-based things they already do well.',
        '',
        '**4. Biggest Wins (Top 5 Fixes)** — ranked by impact. For each: What to change, Where (headline/About/experience/skills…), Why, and How — including a concrete rewrite or exact example.',
        '',
        '**5. Copy Rewrites** — at least one new headline option and one new About opening paragraph they can paste directly. Make them feel crafted, not templated.',
        '',
        '**6. Quick Wins (under 15 minutes)** — fast fixes that need no new content.',
        '',
        'TONE & RULES:',
        '- Be warm, direct, and specific. Never vague or generic. Honesty with evidence over flattery.',
        '- Use clean markdown (headings, bold, bullets, tables) so it is easy to skim.',
        '- You only see what the user shares or what is attached. Never invent private data or metrics; if a section is missing from the fetched content, tell the user how to make it public or paste it.',
        '- If the user pastes a non-LinkedIn link or asks something off-topic, politely steer back to profile work.',
        '- If the user is not ready to share a profile, still give genuinely useful general LinkedIn/personal-branding advice.',
        '- Ask at most ONE clarifying question before delivering value.',
        '- End every audit with: "Want me to dig deeper into any section, or rewrite your headline/About for you?"'
    ].join('\n');

    /* ------------------------------------------------------------------ */

    var STORAGE_KEY = 'sandra-ai-chat-v1';

    var SUGGESTION_CHIPS = [
        { label: '🔎 Audit my LinkedIn profile', value: 'Please audit my LinkedIn profile. Here is my profile URL: ' },
        { label: 'Why don\'t I get much engagement on my posts?', value: 'Why don\'t I get much engagement on my LinkedIn posts? Give me 3 actionable fixes.' }
    ];

    var STATE = {
        open: false,
        streaming: false,
        history: []
    };

    var ROOT, LAUNCHER, PANEL, CLOSE_BTN, CLEAR_BTN, MSGS, SUGGESTIONS, INPUT, SEND;

    function $(id) { return document.getElementById(id); }

    function init() {
        ROOT = $('ai-widget');
        if (!ROOT) return;
        LAUNCHER = $('ai-launcher');
        PANEL = $('ai-panel');
        CLOSE_BTN = $('ai-close');
        CLEAR_BTN = $('ai-clear');
        MSGS = $('ai-messages');
        SUGGESTIONS = $('ai-suggestions');
        INPUT = $('ai-input');
        SEND = $('ai-send');
        if (!PANEL || !MSGS || !INPUT) return;

        LAUNCHER.addEventListener('click', togglePanel);
        if (CLOSE_BTN) CLOSE_BTN.addEventListener('click', function () { togglePanel(false); });
        if (CLEAR_BTN) CLEAR_BTN.addEventListener('click', clearChat);

        /* Close on outside click or Escape (keeps the widget usable without
           leaving the floating trigger "open" behind). */
        document.addEventListener('click', function (e) {
            if (!STATE.open) return;
            var t = e.target;
            if (t && (PANEL.contains(t) || LAUNCHER.contains(t))) return;
            togglePanel(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && STATE.open) togglePanel(false);
        });
        SEND.addEventListener('click', function () { send(); });
        INPUT.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        });
        INPUT.addEventListener('input', autoGrow);

        renderSuggestions();
        restoreChat();
    }

    /* ---------------- panel open/close ---------------- */

    function togglePanel(forceOpen) {
        STATE.open = forceOpen !== undefined ? !!forceOpen : !STATE.open;
        PANEL.classList.toggle('open', STATE.open);
        LAUNCHER.classList.toggle('open', STATE.open);
        LAUNCHER.setAttribute('aria-expanded', STATE.open ? 'true' : 'false');
        var icon = LAUNCHER.querySelector('.ai-launcher-icon i') || LAUNCHER.querySelector('.ai-launcher-icon');
        if (icon) {
            icon.className = STATE.open ? 'fa-solid fa-xmark' : 'fa-solid fa-sparkles';
        }
        if (STATE.open) {
            setTimeout(function () { INPUT.focus(); }, 280);
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
    }

    function clearChat() {
        if (STATE.streaming) return;
        STATE.history = [];
        saveChat();
        MSGS.innerHTML = '';
        SUGGESTIONS.classList.remove('hidden');
        showWelcome();
    }

    /* ---------------- message rendering ---------------- */

    function scrollBottom() {
        if (MSGS) MSGS.scrollTop = MSGS.scrollHeight;
    }

    function addUserMessage(text) {
        var d = document.createElement('div');
        d.className = 'ai-msg user';
        d.textContent = text;
        MSGS.appendChild(d);
        scrollBottom();
    }

    function createAssistantMessage(initial, opts) {
        opts = opts || {};
        var wrap = document.createElement('div');
        wrap.className = 'ai-msg ai';
        var inner = document.createElement('div');
        inner.className = 'ai-md';
        inner.innerHTML = '<span class="ai-typing"><span></span><span></span><span></span></span>';
        wrap.appendChild(inner);
        if (opts.status) {
            var st = document.createElement('div');
            st.className = 'ai-note';
            st.textContent = opts.status;
            wrap.appendChild(st);
        }
        MSGS.appendChild(wrap);
        scrollBottom();

        return {
            wrap: wrap,
            inner: inner,
            setStatus: function (t) {
                if (st) st.textContent = t;
                scrollBottom();
            },
            setLive: function (t) {
                inner.textContent = t;
                scrollBottom();
            },
            setDone: function (md) {
                var txt = (md || '').trim();
                inner.innerHTML = txt ? renderMd(txt) : '<em>(No response received — try again.)</em>';
                if (st) st.textContent = '';
                scrollBottom();
            },
            setError: function (msg) {
                wrap.classList.add('err');
                inner.innerHTML = '<b>Something went wrong.</b><br>' + esc(msg || 'Could not reach the AI service.');
                if (st) st.textContent = '';
                scrollBottom();
            }
        };
    }

    function addStatusNote(text) {
        var d = document.createElement('div');
        d.className = 'ai-note';
        d.textContent = text;
        MSGS.appendChild(d);
        scrollBottom();
        return d;
    }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function renderMd(text) {
        if (window.marked && typeof window.marked.parse === 'function') {
            try { return window.marked.parse(text, { gfm: true, breaks: true }); }
            catch (e) { /* fall through */ }
        }
        return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
    }

    function showWelcome() {
        var b = createAssistantMessage('', { status: 'Free profile audits · Online' });
        b.setDone([
            'Welcome! I\'m **Sandra. AI**, your LinkedIn Profile Audit Agent.',
            '',
            'Drop a **LinkedIn profile link** and I will:',
            '- 🔎 Pull your live profile via internet search',
            '- 📊 Score it across 12 expert audit dimensions',
            '- ✍️ Hand you rewrites for your headline & About',
            '',
            'No URL handy? Pick a suggestion below. 👇'
        ].join('\n'));
    }

    /* ---------------- suggestions ---------------- */

    function renderSuggestions() {
        SUGGESTIONS.innerHTML = '';
        SUGGESTION_CHIPS.forEach(function (c) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ai-chip';
            btn.textContent = c.label;
            btn.title = c.value;
            btn.addEventListener('click', function () { send(c.value); });
            SUGGESTIONS.appendChild(btn);
        });
    }

    /* ---------------- input / send ---------------- */

    function autoGrow() {
        INPUT.style.height = 'auto';
        INPUT.style.height = Math.min(INPUT.scrollHeight, 120) + 'px';
    }

    function send(prefilled) {
        var text = (prefilled != null ? prefilled : INPUT.value).replace(/\s+/g, ' ').trim();
        if (!text || STATE.streaming) return;
        INPUT.value = '';
        autoGrow();
        SUGGESTIONS.classList.add('hidden');

        addUserMessage(text);
        var url = extractLinkedInUrl(text);
        var typingNote = addStatusNote(url
            ? '🔎 Searching for your LinkedIn profile…'
            : '💭 Sandra. AI is thinking…');

        STATE.streaming = true;
        SEND.disabled = true;

        setTimeout(function () {
            gatherProfile(url, function (profileText) {
                var content = text;
                if (url) {
                    if (profileText) {
                        typingNote.textContent = '📊 Auditing your profile…';
                        content += '\n\n[LINKEDIN PROFILE CONTENT — retrieved from the user\'s live profile via internet search]\n'
                            + profileText.slice(0, 70000)
                            + '\n[END PROFILE CONTENT]';
                    } else {
                        content += '\n\n[NOTE: The assistant tried to retrieve the LinkedIn profile at ' + url
                            + ' but failed (blocked, authwall, or private). Audit whatever the user attached, explain what was not accessible, and ask them to paste the profile text if possible.]';
                    }
                }
                STATE.history.push({ role: 'user', content: content });
                typingNote.remove();
                callApi();
            });
        }, 80);
    }

    function extractLinkedInUrl(text) {
        var m = String(text).match(/https?:\/\/[^\s"'<>]+/gi) || [];
        for (var i = 0; i < m.length; i++) {
            var u = m[i].replace(/[,;:!?()\]}]+$/, '');
            if (/linkedin\.com\//i.test(u)) return u;
        }
        return null;
    }

    function gatherProfile(url, cb) {
        if (!url) { cb(null); return; }
        var reader = 'https://r.jina.ai/' + encodeURIComponent(url);

        function attempt(target) {
            return fetch(target).then(function (r) {
                if (!r.ok) throw new Error('bad status');
                return r.text();
            }).then(function (t) {
                t = (t || '').trim();
                var minimal = t.length < 120 && /authwall|sign in|join now|unauthorized|error/i.test(t);
                if (!t || minimal) throw new Error('blocked or empty');
                return t;
            });
        }

        attempt(reader).then(function (t) { cb(t); })
            .catch(function () {
                // CORS/block fallback through a public CORS proxy
                attempt('https://api.allorigins.win/raw?url=' + encodeURIComponent(reader))
                    .then(function (t) { cb(t); })
                    .catch(function () { cb(null); });
            });
    }

    /* ---------------- API call ---------------- */

    function buildMessages() {
        var msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
        var tail = STATE.history.slice(-20);
        for (var i = 0; i < tail.length; i++) {
            var m = tail[i];
            if (m && m.content) msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content) });
        }
        return msgs;
    }

    function callApi() {
        var bubble = createAssistantMessage('', { status: 'Connecting to Sandra. AI…' });
        var base = (CFG.baseUrl || 'https://opencode.ai/zen/v1').replace(/\/$/, '');
        var useProxy = !!(CFG.proxyEndpoint && String(CFG.proxyEndpoint).trim());
        var endpoint = useProxy ? String(CFG.proxyEndpoint).trim() : base + '/chat/completions';

        var headers = { 'Content-Type': 'application/json' };
        if (!useProxy && CFG.apiKey) headers['Authorization'] = 'Bearer ' + CFG.apiKey;

        var body = {
            model: CFG.model || 'nemotron-3-ultra-free',
            messages: buildMessages(),
            temperature: CFG.temperature != null ? CFG.temperature : 0.4,
            max_tokens: CFG.maxTokens || 3072
        };

        var done = function (text) {
            STATE.streaming = false;
            SEND.disabled = false;
            text = (text || '').trim();
            bubble.setDone(text);
            if (text) {
                STATE.history.push({ role: 'assistant', content: text });
                saveChat();
            }
        };

        var fail = function (err) {
            STATE.streaming = false;
            SEND.disabled = false;
            var msg = (err && err.message) ? err.message : 'Could not reach the AI service.';
            if (/CORS|Failed to fetch|NetworkError/i.test(msg)) {
                msg = 'Your browser blocked direct access to the AI service (CORS). Fix: deploy the site with a backend proxy (see ai-config.example.js). For now, paste your profile content as text instead of a link, then retry.';
            }
            bubble.setError(msg);
        };

        if (CFG.stream !== false) {
            streamRequest(endpoint, headers, body, bubble).then(done).catch(fail);
        } else {
            plainRequest(endpoint, headers, body).then(done).catch(fail);
        }
    }

    function plainRequest(endpoint, headers, body) {
        return fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
        }).then(function (res) {
            if (!res.ok) {
                return res.text().catch(function () { return ''; }).then(function (t) {
                    throw serviceError(res.status, t);
                });
            }
            return res.json().then(function (data) {
                if (data && data.choices && data.choices[0]) {
                    var m = data.choices[0].message || {};
                    return m.content || '';
                }
                throw new Error('Unexpected response from the AI service.');
            });
        });
    }

    function serviceError(status, raw) {
        var msg = '';
        try {
            var d = JSON.parse(raw || '');
            msg = (d && d.error && d.error.message) || (d && d.detail) || '';
        } catch (e) { msg = ''; }
        if (typeof msg !== 'string') msg = '';
        if (status === 429) return new Error('Sandra. AI is rate limited right now. Please try again in a minute.');
        if (status === 400) return new Error(msg || 'The AI request was rejected.');
        if (status === 401 || status === 403) return new Error('Sandra. AI is not configured correctly (the provider rejected the key).');
        if (status >= 500) return new Error('Every AI model is busy or unavailable right now. Please try again shortly.');
        return new Error('HTTP ' + status + ' ' + String(raw || '').slice(0, 200));
    }

    function streamRequest(endpoint, headers, body, bubble) {
        return new Promise(function (resolve, reject) {
            bubble.setStatus('Sandra. AI is thinking…');
            fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(Object.assign({}, body, { stream: true }))
            }).then(function (res) {
                if (!res.ok) {
                    return res.text().catch(function () { return ''; }).then(function (t) {
                        throw serviceError(res.status, t);
                    });
                }
                if (!res.body) {
                    // Non-streaming JSON came back anyway
                    return res.json().then(function (data) {
                        if (data && data.choices && data.choices[0]) {
                            return (data.choices[0].message || {}).content || '';
                        }
                        throw new Error('Unexpected response from the AI service.');
                    });
                }
                var ct = (res.headers.get('content-type') || '').toLowerCase();
                if (ct.indexOf('text/event-stream') === -1) {
                    // Got a plain JSON payload despite stream:true
                    return res.json().catch(function () { return null; }).then(function (data) {
                        if (data && data.choices && data.choices[0]) {
                            return (data.choices[0].message || {}).content || '';
                        }
                        return res.text().catch(function () { return ''; });
                    });
                }

                bubble.setStatus('');
                var reader = res.body.getReader();
                var dec = new TextDecoder('utf-8');
                var buf = '';
                var acc = '';
                var finished = false;

                function pump() {
                    return reader.read().then(function (r) {
                        if (r.done) { resolve(acc); return; }
                        buf += dec.decode(r.value, { stream: true });
                        var m;
                        while ((m = buf.match(/\r\n\r\n|\n\n/))) {
                            var chunk = buf.slice(0, m.index);
                            buf = buf.slice(m.index + m[0].length);
                            var line = null;
                            var parts = chunk.split(/\r?\n/);
                            for (var i = 0; i < parts.length; i++) {
                                if (parts[i].indexOf('data:') === 0) { line = parts[i].slice(5).trim(); break; }
                            }
                            if (!line) continue;
                            if (line === '[DONE]') { finished = true; break; }
                            try {
                                var ev = JSON.parse(line);
                                var ch = ev.choices && ev.choices[0];
                                if (!ch) continue;
                                var delta = (ch.delta && ch.delta.content) || (ch.message && ch.message.content) || '';
                                if (delta) {
                                    acc += delta;
                                    bubble.setLive(acc);
                                }
                                if (ch.finish_reason) finished = true;
                            } catch (e) { /* skip partial/malformed lines */ }
                        }
                        if (finished) { resolve(acc); return; }
                        return pump();
                    });
                }
                return pump();
            }).then(function (val) {
                resolve(val);
            }).catch(reject);
        });
    }

    /* ---------------- persistence ---------------- */

    function saveChat() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ h: STATE.history.slice(-40) })); }
        catch (e) { /* ignore */ }
    }

    function restoreChat() {
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
        catch (e) { /* ignore */ }
        if (saved && saved.h && saved.h.length) {
            STATE.history = saved.h.slice(-40);
            STATE.history.forEach(function (m) {
                if (m.role === 'user') addUserMessage(m.content);
                else if (m.role === 'assistant') {
                    var b = createAssistantMessage('', {});
                    b.setDone(m.content);
                }
            });
            return;
        }
        showWelcome();
    }

    /* ---------------- boot ---------------- */

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();