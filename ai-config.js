/* Sandra. AI — chat configuration (proxy mode; no secrets shipped to the browser).
   proxyEndpoint points at the Render-hosted backend (server/app.py). */
window.OpenCodeAI = {
    proxyEndpoint: "https://sandra-oluoma.onrender.com/v1/chat/completions",
    baseUrl: "",
    model: "nemotron-3-ultra-free",
    apiKey: "",
    temperature: 0.4,
    /* A full scorecard plus top-5 fixes with worked examples runs long. At 3072
       the reply was being cut off before the closing 1:1 offer, so the booking
       card silently never appeared. 6144 leaves headroom. */
    maxTokens: 6144,
    stream: true
};