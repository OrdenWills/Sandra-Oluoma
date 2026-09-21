/* Sandra. AI — chat configuration
   Copy this file to ai-config.js and fill in your values.
   ai-config.js is gitignored (see .gitignore). */
window.OpenCodeAI = {
    /* Production (recommended): point at a backend proxy so the API key
       never ships to the browser. The proxy must accept an OpenAI-style
       POST with { messages, model, temperature, max_tokens, stream }.
       e.g. proxyEndpoint: "https://your-proxy.worker.dev/v1/chat/completions"
    */
    proxyEndpoint: "",
    /* Direct mode (dev / static hosting): calls the OpenCode AI API
       straight from the browser using apiKey below. */
    baseUrl: "https://opencode.ai/zen/v1",
    model: "nemotron-3-ultra-free",
    apiKey: "",
    temperature: 0.4,
    maxTokens: 3072,
    stream: true
};