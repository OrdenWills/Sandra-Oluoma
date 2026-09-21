/* Sandra. AI — Cloudflare Worker proxy for the chat widget.

   WHY: The widget (ai-widget.js) supports two calling modes:
     1. Direct:  browser POSTs to baseUrl + "/chat/completions" with the
        OpenCode key in an Authorization header.
     2. Proxy:   browser POSTs to proxyEndpoint (a Worker) with NO key, and
        this Worker forwards to the AI API with the key held server-side —
        in an OPENCODE_API_KEY binding (secret). This is the recommended
        setup: the key never ships to the browser.

   The widget picks proxy mode automatically when ai-config.js has
   `proxyEndpoint` set:

        window.OpenCodeAI = {
            proxyEndpoint: "https://your-worker.your-subdomain.workers.dev/chat/completions",
            baseUrl: "https://opencode.ai/zen/v1",   // unused in proxy mode
            model: "...",
            apiKey: "",                              // leave empty in proxy mode
            ...
        };

   Deploy — bare `wrangler deploy ai-proxy.worker.js` after adding the
   OPENCODE_API_KEY secret so it reads env at runtime.

   Requires: env.OPENCODE_API_KEY  (the secret / AI key)
            optional env.LLM_BASE_URL (defaults to opencode zen)
            optional env.LLM_MODEL    (defaults to nemotron-3-ultra-free)
*/

var UPSTREAM_BASE = 'https://opencode.ai/zen/v1';
var DEFAULT_MODEL = 'nemotron-3-ultra-free';

/* ---------------- small helpers ---------------- */

function json(data, status, extra) {
    var h = { 'Content-Type': 'application/json' };
    for (var k in (extra || {})) h[k] = extra[k];
    return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}

function corsHeaders(origin) {
    var h = {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
        'Access-Control-Max-Age': '86400'
    };
    // mirror preflight/plain responses
    if (origin) h['Vary'] = 'Origin';
    return h;
}

/* ---------------- main handler ---------------- */

async function handle(request, env) {
    var url = new URL(request.url);
    var origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
        return json({ error: 'Only POST allowed' }, 405, corsHeaders(origin));
    }

    var apiKey = (env && env.OPENCODE_API_KEY) || '';
    if (!apiKey) {
        return json({
            error: 'PROXY_MISSING_KEY',
            message: 'This AI proxy has no OPENCODE_API_KEY binding set. ' +
                'Add it in Cloudflare > Workers > Settings > Variables (Secret), then retry.'
        }, 500, corsHeaders(origin));
    }

    var baseUrl = ((env && env.LLM_BASE_URL) || UPSTREAM_BASE).replace(/\/$/, '');
    var model = (env && env.LLM_MODEL) || DEFAULT_MODEL;

    var body;
    try { body = await request.json(); }
    catch (e) { return json({ error: 'Invalid JSON body' }, 400, corsHeaders(origin)); }

    var wantStream = !!(body && body.stream);
    var messages = (body && body.messages) || [];
    if (!messages.length) {
        return json({ error: 'messages is required' }, 400, corsHeaders(origin));
    }

    var upstreamBody = {
        model: (body && body.model) || model,
        messages: messages,
        temperature: body && body.temperature != null ? body.temperature : 0.4,
        max_tokens: body && body.max_tokens ? body.max_tokens : 3072,
        stream: wantStream
    };

    var upstreamURL = baseUrl + '/chat/completions';

    var upstream = await fetch(upstreamURL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify(upstreamBody)
    });

    if (!upstream.ok) {
        var errTxt = await upstream.text();
        var code = upstream.status;
        var out;
        try { out = { error: 'UPSTREAM_' + code, detail: JSON.parse(errTxt) }; }
        catch (e) { out = { error: 'UPSTREAM_' + code, message: errTxt.slice(0, 500) }; }
        return json(out, code, corsHeaders(origin));
    }

    if (wantStream) {
        // Pass the SSE stream straight through to the browser.
        return new Response(upstream.body, {
            status: 200,
            headers: Object.assign({
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            }, corsHeaders(origin))
        });
    }

    var data = await upstream.text();
    return json(JSON.parse(data), 200, corsHeaders(origin));
}

/* ---------------- edge entrypoint ---------------- */

export default {
    async fetch(request, env) {
        try { return await handle(request, env); }
        catch (e) {
            return json({
                error: 'PROXY_INTERNAL',
                message: String((e && e.message) || e).slice(0, 300)
            }, 500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        }
    }
};
