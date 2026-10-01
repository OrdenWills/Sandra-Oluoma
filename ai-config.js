/* Sandra. AI — chat configuration (proxy mode; no secrets shipped to the browser).
   proxyEndpoint points at the Render-hosted backend (server/app.py). */
window.OpenCodeAI = {
    proxyEndpoint: "https://sandra-oluoma.onrender.com/v1/chat/completions",
    baseUrl: "",
    model: "nemotron-3-ultra-free",
    apiKey: "",
    temperature: 0.4,
    maxTokens: 3072,
    stream: true
};