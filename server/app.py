"""Sandra AI backend — FastAPI proxy for the LinkedIn Profile Audit widget.

Provider order: Gemini (primary) -> OpenCode (failover).
Each provider is retried (backoff) before failing over to the next.
Only when ALL providers fail does the request fail (502 + per-provider summary).

Exposes an OpenAI-compatible surface the static widget already speaks:
  POST /v1/chat/completions   {model, messages, temperature, max_tokens, stream}
  GET  /health
  GET  /

CORS is locked to the production frontend origin(s) + localhost dev.
Secrets live only in server/.env (gitignored) or Render env vars — never in git.
"""

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

load_dotenv()  # server/.env locally; Render injects env vars directly

# ---------------------------------------------------------------- config ---

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
OPENCODE_API_KEY = os.getenv("OPENCODE_API_KEY", "").strip()
OPENCODE_BASE_URL = os.getenv("OPENCODE_BASE_URL", "https://opencode.ai/zen/v1").strip().rstrip("/")
OPENCODE_MODEL = os.getenv("OPENCODE_MODEL", "nemotron-3-ultra-free").strip()
FRONTEND_ORIGINS = [
    o.strip()
    for o in os.getenv("FRONTEND_ORIGINS", "https://sandra-chukwuemeka.github.io").split(",")
    if o.strip()
]
# Testing convenience: allow any origin. Set to false for a locked-down production.
CORS_ALLOW_ALL = os.getenv("CORS_ALLOW_ALL_ORIGINS", "true").strip().lower() in ("1", "true", "yes")
MAX_RETRIES = max(0, int(os.getenv("MAX_RETRIES_PER_PROVIDER", "2") or 2))
HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=90.0, write=15.0, pool=10.0)

# ---------------------------------------------------------------- logging ---

logger = logging.getLogger("sandra-ai")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(_h)
logger.setLevel(logging.INFO)
logger.propagate = False

# ------------------------------------------------------------------ app ---

app = FastAPI(title="Sandra AI backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if CORS_ALLOW_ALL else FRONTEND_ORIGINS,
    allow_origin_regex=None if CORS_ALLOW_ALL else r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Accept"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("%s %s failed", request.method, request.url.path)
        raise
    ms = (time.perf_counter() - start) * 1000
    logger.info("%s %s %s %.0fms", request.method, request.url.path,
                response.status_code, ms)
    return response


# ---------------------------------------------------------------- models ---

class ChatMessage(BaseModel):
    role: str = "user"
    content: Any = ""


class ChatRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage] = Field(default_factory=list)
    temperature: float = 0.4
    max_tokens: int = 3072
    stream: bool = False


# ---------------------------------------------------------------- errors ---

class ProviderError(Exception):
    """Raised when a provider call fails. retryable=False means don't retry
    this provider (e.g. bad key / bad request) — fail over immediately."""

    def __init__(self, provider: str, message: str, retryable: bool = True):
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable


def _redacted(msg: str) -> str:
    # Never leak key material into logs/responses.
    for secret in (GEMINI_API_KEY, OPENCODE_API_KEY):
        if secret and len(secret) > 8 and secret in msg:
            msg = msg.replace(secret, secret[:4] + "…[redacted]")
    return msg[:600]


# ------------------------------------------------- message conversion ---

def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # OpenAI multipart: [{type:'text',text:...}]
        return "\n".join(
            str(p.get("text", "")) for p in content
            if isinstance(p, dict) and p.get("type") == "text" and p.get("text")
        )
    return str(content or "")


def to_gemini_payload(messages: List[ChatMessage], temperature: float,
                      max_tokens: int) -> Dict[str, Any]:
    """OpenAI messages -> Gemini generateContent body."""
    system_parts: List[str] = []
    contents: List[Dict[str, Any]] = []
    for m in messages:
        role = (m.role or "user").lower()
        text = _text_of(m.content)
        if not text.strip():
            continue
        if role == "system":
            system_parts.append(text)
            continue
        g_role = "model" if role == "assistant" else "user"
        if contents and contents[-1]["role"] == g_role:
            contents[-1]["parts"][0]["text"] += "\n" + text
        else:
            contents.append({"role": g_role, "parts": [{"text": text}]})
    # Gemini requires the first turn to be from the user.
    while contents and contents[0]["role"] != "user":
        contents.pop(0)
    if not contents:
        contents = [{"role": "user", "parts": [{"text": "Hello"}]}]
    body: Dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": max(0.0, min(2.0, temperature)),
            "maxOutputTokens": max(1, min(8192, max_tokens)),
        },
    }
    if system_parts:
        body["system_instruction"] = {"parts": [{"text": "\n".join(system_parts)}]}
    return body


def gemini_text(resp: Dict[str, Any]) -> str:
    cands = resp.get("candidates") or []
    if not cands:
        fb = resp.get("promptFeedback") or {}
        reason = fb.get("blockReason") or "no candidates"
        raise ProviderError("gemini", f"blocked/empty response ({reason})",
                            retryable=False)
    parts = ((cands[0].get("content") or {}).get("parts")) or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    if not text:
        finish = cands[0].get("finishReason", "unknown")
        raise ProviderError("gemini", f"empty text (finish={finish})",
                            retryable=False)
    return text


def openai_completion(cid: str, model: str, text: str) -> Dict[str, Any]:
    return {
        "id": cid, "object": "chat.completion", "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                     "finish_reason": "stop"}],
    }


def openai_chunk(cid: str, model: str, delta: str,
                 finish: Optional[str] = None) -> str:
    return "data: " + json.dumps({
        "id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": {"content": delta} if delta else {},
                     "finish_reason": finish}],
    }) + "\n\n"


# ------------------------------------------------------------ providers ---

async def call_gemini(client: httpx.AsyncClient, req: ChatRequest) -> str:
    if not GEMINI_API_KEY:
        raise ProviderError("gemini", "GEMINI_API_KEY not configured",
                            retryable=False)
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent")
    try:
        r = await client.post(
            url, headers={"x-goog-api-key": GEMINI_API_KEY,
                          "Content-Type": "application/json"},
            json=to_gemini_payload(req.messages, req.temperature, req.max_tokens),
        )
    except (httpx.TimeoutException, httpx.ConnectError) as e:
        raise ProviderError("gemini", f"network error: {e}")
    if r.status_code == 429 or r.status_code >= 500:
        raise ProviderError("gemini", f"HTTP {r.status_code}: {_redacted(r.text)}")
    if r.status_code != 200:
        raise ProviderError("gemini", f"HTTP {r.status_code}: {_redacted(r.text)}",
                            retryable=False)
    return gemini_text(r.json())


async def stream_gemini(client: httpx.AsyncClient, req: ChatRequest,
                        cid: str) -> AsyncIterator[str]:
    """Yield OpenAI-style SSE chunks translated from Gemini's SSE stream."""
    if not GEMINI_API_KEY:
        raise ProviderError("gemini", "GEMINI_API_KEY not configured",
                            retryable=False)
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:streamGenerateContent?alt=sse")
    try:
        async with client.stream(
            "POST", url,
            headers={"x-goog-api-key": GEMINI_API_KEY,
                     "Content-Type": "application/json",
                     "Accept": "text/event-stream"},
            json=to_gemini_payload(req.messages, req.temperature, req.max_tokens),
        ) as r:
            if r.status_code == 429 or r.status_code >= 500:
                body = await r.aread()
                raise ProviderError(
                    "gemini", f"HTTP {r.status_code}: {_redacted(body.decode(errors='ignore'))}")
            if r.status_code != 200:
                body = await r.aread()
                raise ProviderError(
                    "gemini", f"HTTP {r.status_code}: {_redacted(body.decode(errors='ignore'))}",
                    retryable=False)
            buf = ""
            async for raw in r.aiter_text():
                buf += raw
                while "\n\n" in buf:
                    event, buf = buf.split("\n\n", 1)
                    line = next((ln[5:].strip() for ln in event.splitlines()
                                 if ln.startswith("data:")), "")
                    if not line or line == "[DONE]":
                        continue
                    try:
                        chunk_data = json.loads(line)
                        # Extract delta directly from streaming chunk (not full response)
                        text = None
                        cands = chunk_data.get("candidates") or []
                        if cands:
                            parts = ((cands[0].get("content") or {}).get("parts")) or []
                            for p in parts:
                                if isinstance(p, dict) and p.get("text"):
                                    text = p.get("text")
                                    break
                        if text:
                            yield openai_chunk(cid, GEMINI_MODEL, text)
                    except (json.JSONDecodeError, ProviderError):
                        continue
    except (httpx.TimeoutException, httpx.ConnectError) as e:
        raise ProviderError("gemini", f"network error: {e}")
    yield openai_chunk(cid, GEMINI_MODEL, "", finish="stop")
    yield "data: [DONE]\n\n"


async def call_opencode(client: httpx.AsyncClient, req: ChatRequest) -> str:
    if not OPENCODE_API_KEY:
        raise ProviderError("opencode", "OPENCODE_API_KEY not configured",
                            retryable=False)
    try:
        r = await client.post(
            f"{OPENCODE_BASE_URL}/chat/completions",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {OPENCODE_API_KEY}"},
            json={"model": OPENCODE_MODEL,
                  "messages": [{"role": m.role, "content": _text_of(m.content)}
                               for m in req.messages],
                  "temperature": max(0.0, min(2.0, req.temperature)),
                  "max_tokens": max(1, min(8192, req.max_tokens)),
                  "stream": False},
        )
    except (httpx.TimeoutException, httpx.ConnectError) as e:
        raise ProviderError("opencode", f"network error: {e}")
    if r.status_code == 429 or r.status_code >= 500:
        raise ProviderError("opencode", f"HTTP {r.status_code}: {_redacted(r.text)}")
    if r.status_code != 200:
        raise ProviderError("opencode", f"HTTP {r.status_code}: {_redacted(r.text)}",
                            retryable=False)
    try:
        data = r.json()
        text = (((data.get("choices") or [{}])[0].get("message")) or {}).get("content") or ""
    except (ValueError, AttributeError, IndexError):
        raise ProviderError("opencode", "unexpected response shape",
                            retryable=False)
    if not text.strip():
        raise ProviderError("opencode", "empty completion", retryable=False)
    return text


async def stream_opencode(client: httpx.AsyncClient, req: ChatRequest,
                          cid: str) -> AsyncIterator[str]:
    """Pass the upstream OpenAI-style SSE through, normalising the ending."""
    if not OPENCODE_API_KEY:
        raise ProviderError("opencode", "OPENCODE_API_KEY not configured",
                            retryable=False)
    try:
        async with client.stream(
            "POST", f"{OPENCODE_BASE_URL}/chat/completions",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {OPENCODE_API_KEY}",
                     "Accept": "text/event-stream"},
            json={"model": OPENCODE_MODEL,
                  "messages": [{"role": m.role, "content": _text_of(m.content)}
                               for m in req.messages],
                  "temperature": max(0.0, min(2.0, req.temperature)),
                  "max_tokens": max(1, min(8192, req.max_tokens)),
                  "stream": True},
        ) as r:
            if r.status_code == 429 or r.status_code >= 500:
                body = await r.aread()
                raise ProviderError(
                    "opencode", f"HTTP {r.status_code}: {_redacted(body.decode(errors='ignore'))}")
            if r.status_code != 200:
                body = await r.aread()
                raise ProviderError(
                    "opencode",
                    f"HTTP {r.status_code}: {_redacted(body.decode(errors='ignore'))}",
                    retryable=False)
            async for raw in r.aiter_text():
                # Upstream is already OpenAI SSE — forward verbatim.
                yield raw
    except (httpx.TimeoutException, httpx.ConnectError) as e:
        raise ProviderError("opencode", f"network error: {e}")
    yield "data: [DONE]\n\n"


# ------------------------------------------------- retry + failover ---

async def _with_retries(label: str, fn, *args):
    """Run one provider with backoff. Returns (result) or raises the LAST
    ProviderError after retries are exhausted."""
    last: Optional[ProviderError] = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            return await fn(*args)
        except ProviderError as e:
            last = e
            logger.warning("[%s] attempt %d/%d failed: %s", label, attempt + 1,
                           MAX_RETRIES + 1, _redacted(str(e)))
            if not e.retryable or attempt >= MAX_RETRIES:
                break
            await asyncio.sleep(0.5 * (2 ** attempt))
    assert last is not None
    raise last


# --------------------------------------------------------------- routes ---

@app.get("/")
async def root():
    return {"service": "sandra-ai-backend", "status": "ok",
            "providers": ["gemini", "opencode"],
            "docs": "POST /v1/chat/completions with {messages, model?, temperature?, max_tokens?, stream?}"}


@app.get("/health")
async def health():
    return {"status": "ok",
            "providers": ["gemini", "opencode"],
            "gemini": {"configured": bool(GEMINI_API_KEY), "model": GEMINI_MODEL},
            "opencode": {"configured": bool(OPENCODE_API_KEY), "model": OPENCODE_MODEL,
                         "base_url": OPENCODE_BASE_URL},
            "cors_allow_all": CORS_ALLOW_ALL,
            "cors_origins": FRONTEND_ORIGINS}


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest, request: Request):
    if not req.messages:
        raise HTTPException(status_code=400, detail="messages is required")
    cid = "chatcmpl-" + uuid.uuid4().hex[:12]
    failures: Dict[str, str] = {}

    if req.stream:
        # Streaming: first provider that yields a first byte wins; if it
        # fails BEFORE any byte is sent, fail over to the next provider.
        # NOTE: the HTTP client must live inside the generator — Starlette
        # only iterates the body AFTER this route returns.
        async def _gen() -> AsyncIterator[str]:
            client = httpx.AsyncClient(timeout=HTTP_TIMEOUT)
            try:
                streamers = [("gemini", stream_gemini), ("opencode", stream_opencode)]
                for idx, (name, fn) in enumerate(streamers):
                    try:
                        async for chunk in _with_retries_stream(name, fn, client, req, cid):
                            yield chunk
                        return  # stream completed
                    except ProviderError as e:
                        failures[name] = str(e)
                        logger.warning("[%s] stream failed: %s", name, _redacted(str(e)))
                        if idx == len(streamers) - 1:
                            yield ("data: " + json.dumps(
                                {"error": {"message": "All providers failed: " + "; ".join(
                                    f"{k}: {v}" for k, v in failures.items()),
                                 "type": "provider_error"}}) + "\n\n")
                            yield "data: [DONE]\n\n"
                            return
                        # else: fall through to next provider (nothing sent yet
                        # only if failure happened pre-first-byte; mid-stream
                        # failure also lands here — client keeps partial text)
            finally:
                await client.aclose()
        return StreamingResponse(_gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache",
                                          "X-Accel-Buffering": "no"})

    # Non-streaming: try gemini, fail over to opencode.
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        for name, fn in (("gemini", call_gemini), ("opencode", call_opencode)):
            try:
                text = await _with_retries(name, fn, client, req)
                return JSONResponse(openai_completion(cid, req.model or name, text))
            except ProviderError as e:
                failures[name] = str(e)
    raise HTTPException(
        status_code=502,
        detail={"error": "All providers failed",
                "providers": failures})


async def _with_retries_stream(name, fn, client, req, cid):
    """Async-generator wrapper applying per-provider retries for streams."""
    last: Optional[ProviderError] = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            async for chunk in fn(client, req, cid):
                yield chunk
            return
        except ProviderError as e:
            last = e
            logger.warning("[%s] stream attempt %d/%d failed: %s", name, attempt + 1,
                           MAX_RETRIES + 1, _redacted(str(e)))
            if not e.retryable or attempt >= MAX_RETRIES:
                break
            await asyncio.sleep(0.5 * (2 ** attempt))
    assert last is not None
    raise last
