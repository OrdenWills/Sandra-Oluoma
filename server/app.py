"""Sandra AI backend — FastAPI proxy for the LinkedIn Profile Audit widget.

Provider chain: CleanAPIs (primary) -> Gemini (failover 1) -> OpenCode (failover 2).
The chain is a flat list of (provider, model) *candidates*. A candidate is only
tried when the previous one could not answer:

  * resource exhausted / quota  -> rotate to the next MODEL, then next provider
  * model unavailable / 5xx     -> rotate to the next MODEL, then next provider
  * network error / empty body  -> rotate (re-tried in place only if
                                   MAX_RETRIES_PER_PROVIDER > 0, default 0)
  * dead key / no entitlement / billing -> abandon that provider, next provider
  * bad request / blocked content -> stop, return the error

The moment a candidate produces its FIRST content delta the response starts
streaming to the client and no other provider is ever contacted. After that
point failover is impossible (partial text is already delivered), so a failure
closes the stream with an error frame instead of silently appending a second
answer.

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
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

load_dotenv()  # server/.env locally; Render injects env vars directly

# ---------------------------------------------------------------- config ---

def _env(*names: str, default: str = "") -> str:
    for n in names:
        v = os.getenv(n)
        if v is not None and v.strip():
            return v.strip()
    return default


def _model_list(primary: str, fallbacks: str) -> List[str]:
    """Primary model first, then comma-separated fallbacks, de-duplicated."""
    out: List[str] = []
    for m in [primary] + fallbacks.split(","):
        m = m.strip()
        if m and m not in out:
            out.append(m)
    return out


CLEAN_API_KEY = _env("CLEAN_API_KEY", "clean_api_key")
CLEAN_BASE_URL = _env("CLEAN_BASE_URL", default="https://cleanapis.com/v1").rstrip("/")
CLEAN_MODELS = _model_list(_env("CLEAN_MODEL", default="claude-opus-4.8"),
                           _env("CLEAN_MODEL_FALLBACKS"))

GEMINI_API_KEY = _env("GEMINI_API_KEY")
GEMINI_BASE_URL = _env("GEMINI_BASE_URL",
                       default="https://generativelanguage.googleapis.com/v1beta").rstrip("/")
GEMINI_MODELS = _model_list(_env("GEMINI_MODEL", default="gemini-2.5-flash"),
                            _env("GEMINI_MODEL_FALLBACKS"))

OPENCODE_API_KEY = _env("OPENCODE_API_KEY")
OPENCODE_BASE_URL = _env("OPENCODE_BASE_URL", default="https://opencode.ai/zen/v1").rstrip("/")
OPENCODE_MODELS = _model_list(_env("OPENCODE_MODEL", default="nemotron-3-ultra-free"),
                              _env("OPENCODE_MODEL_FALLBACKS"))

FRONTEND_ORIGINS = [
    o.strip()
    for o in _env("FRONTEND_ORIGINS", default="https://sandra-chukwuemeka.github.io").split(",")
    if o.strip()
]
# Testing convenience: allow any origin. Set to false for a locked-down production.
CORS_ALLOW_ALL = _env("CORS_ALLOW_ALL_ORIGINS", default="true").lower() in ("1", "true", "yes")

# Same-candidate retries. 0 = never re-hammer a model that already said
# "resource exhausted" / "model unavailable" — rotate to the next model instead.
MAX_RETRIES_PER_PROVIDER = max(0, int(_env("MAX_RETRIES_PER_PROVIDER", default="0") or 0))
# How long to wait for a candidate's first content delta before rotating.
FIRST_TOKEN_TIMEOUT = float(_env("FIRST_TOKEN_TIMEOUT", default="60") or 60)
MAX_ERROR_BODY = 4096          # bytes of upstream error text kept for logs
MAX_JSON_BODY = 8 * 1024 * 1024  # cap for non-SSE bodies we have to buffer

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

app = FastAPI(title="Sandra AI backend", version="1.1.0")

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
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None


class ChatRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage] = Field(default_factory=list)
    temperature: float = 0.4
    max_tokens: int = 3072
    stream: bool = False
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Any] = None


# ------------------------------------------------------- candidate chain ---

@dataclass(frozen=True)
class Candidate:
    provider: str
    model: str
    kind: str        # "openai" (OpenAI-compatible) | "gemini"
    base_url: str
    api_key: str

    @property
    def label(self) -> str:
        return f"{self.provider}/{self.model}"


REGISTRY: Dict[str, Dict[str, Any]] = {
    "cleanapis": {"key": CLEAN_API_KEY, "base": CLEAN_BASE_URL,
                  "models": CLEAN_MODELS, "kind": "openai"},
    "gemini": {"key": GEMINI_API_KEY, "base": GEMINI_BASE_URL,
               "models": GEMINI_MODELS, "kind": "gemini"},
    "opencode": {"key": OPENCODE_API_KEY, "base": OPENCODE_BASE_URL,
                 "models": OPENCODE_MODELS, "kind": "openai"},
}
DEFAULT_ORDER = ["cleanapis", "gemini", "opencode"]


def _pinned_model(provider: str, hint: str) -> Optional[str]:
    """The client may pin a model; only honour it on providers that serve it."""
    low = hint.lower()
    if not hint:
        return None
    if provider == "gemini":
        return hint if "gemini" in low else None
    if provider == "opencode":
        return hint if ("nemotron" in low or "opencode" in low) else None
    # cleanapis fronts the general OpenAI-compatible catalogue
    if any(k in low for k in ("gemini", "nemotron", "opencode")):
        return None
    return hint


def build_groups(req: ChatRequest) -> List[Tuple[str, List[Candidate]]]:
    """Ordered [(provider, [candidate models])] pairs. Unconfigured providers are skipped.

    Models are grouped per provider so a dead provider (dead key, no
    entitlement) can be abandoned without burning its whole model list.
    """
    hint = (req.model or "").strip()
    order = list(DEFAULT_ORDER)
    if "gemini" in hint.lower():
        order = ["gemini", "cleanapis", "opencode"]
    groups: List[Tuple[str, List[Candidate]]] = []
    for name in order:
        p = REGISTRY[name]
        if not p["key"]:
            continue
        models: List[str] = []
        pinned = _pinned_model(name, hint)
        if pinned:
            models.append(pinned)
        models.extend(p["models"])
        seen = set()
        cands: List[Candidate] = []
        for m in models:
            m = m.strip()
            if not m or m in seen:
                continue
            seen.add(m)
            cands.append(Candidate(name, m, p["kind"], p["base"], p["key"]))
        if cands:
            groups.append((name, cands))
    return groups


def build_chain(req: ChatRequest) -> List[Candidate]:
    """Flat view of build_groups() (debugging / health)."""
    return [c for _, cands in build_groups(req) for c in cands]


# ---------------------------------------------------------------- errors ---

ROTATE = "rotate"           # try the next model, then the next provider
SKIP_PROVIDER = "skip"       # this provider is dead for this request -> next provider
STOP = "stop"                # only the client can fix it -> surface the error


class ProviderError(Exception):
    """A candidate could not produce an answer.

    kind=ROTATE        -> move on to the next candidate.
    kind=SKIP_PROVIDER -> abandon this provider entirely, move to the next one.
    kind=STOP          -> abort the chain and surface the error to the client.
    """

    def __init__(self, cand: Any, message: str, kind: str = ROTATE,
                 status: Optional[int] = None):
        label = cand.label if isinstance(cand, Candidate) else str(cand)
        super().__init__(message)
        self.cand = cand
        self.label = label
        self.message = message
        self.kind = kind
        self.status = status

    def __str__(self) -> str:
        return f"{self.label}: {self.message}"


def _redacted(msg: str) -> str:
    # Never leak key material into logs/responses.
    for secret in (GEMINI_API_KEY, CLEAN_API_KEY, OPENCODE_API_KEY):
        if secret and len(secret) > 8 and secret in msg:
            msg = msg.replace(secret, secret[:4] + "…[redacted]")
    return msg[:600]


# Error-body fingerprints. Order matters: the first family that matches wins.
_BLOCK_MARKERS = ("safety", "blocked", "blocklist", "content_policy",
                  "prohibited_content", "recitation", "responsible_ai")
_AUTH_MARKERS = ("api key", "api_key", "unauthorized", "authentication",
                 "invalid bearer", "forbidden", "permission", "credential")
_QUOTA_MARKERS = ("resource_exhausted", "resource exhausted", "rate limit",
                  "rate_limit", "too many requests", "quota", "overloaded",
                  "overload_error", "capacity")
# Money problems: the key/account is dead, no other model of that provider helps.
_BILLING_MARKERS = ("billing", "payment method", "insufficient credit",
                    "out of credit", "credit balance", "account suspended",
                    "arrears", "top up", "top-up")
_CTX_MARKERS = ("context length", "context_length", "too many tokens",
                "maximum context", "token limit", "reduce the length",
                "max_tokens", "request too large")
_MODEL_MARKERS = ("high demand", "model_not_found", "model not found",
                  "no such model", "not available", "unavailable",
                  "does not exist", "invalid model", "unknown model",
                  "not supported", "deployment", "not enabled", "temporarily")


def classify(status: int, body: str) -> Tuple[str, str]:
    """Map an upstream failure to (kind, reason).

    ROTATE       -> another model of this provider, then the next provider.
    SKIP_PROVIDER-> this provider is unusable for this request (dead key, no
                    entitlement, wrong endpoint); go straight to the next one.
    STOP         -> only the client can fix it (bad request, blocked content).
    """
    low = (body or "").lower()
    if any(m in low for m in _BLOCK_MARKERS):
        return STOP, "content blocked by upstream"
    if any(m in low for m in _BILLING_MARKERS):
        return SKIP_PROVIDER, "billing/credit rejected"
    if status in (401, 403) or any(m in low for m in _AUTH_MARKERS):
        return SKIP_PROVIDER, f"auth/entitlement rejected (HTTP {status})"
    if status == 429 or any(m in low for m in _QUOTA_MARKERS):
        return ROTATE, "resource exhausted"
    if status in (400, 422) and any(m in low for m in _CTX_MARKERS):
        return ROTATE, "context/token limit"
    if status in (404, 405, 408, 415, 500, 502, 503, 504, 529) or \
            any(m in low for m in _MODEL_MARKERS):
        return ROTATE, "model unavailable"
    if status in (400, 422):
        return STOP, f"bad request (HTTP {status})"
    if status >= 500:
        return ROTATE, f"upstream HTTP {status}"
    return SKIP_PROVIDER, f"provider rejected the call (HTTP {status})"


def _status_from_error_obj(err: Any) -> int:
    if isinstance(err, dict):
        for k in ("code", "status_code", "http_status"):
            v = err.get(k)
            if isinstance(v, int):
                return v
        st = err.get("status")
        if isinstance(st, str) and st.isdigit():
            return int(st)
    return 200


def _error_from_obj(cand: Candidate, err: Any, where: str) -> ProviderError:
    body = json.dumps(err) if not isinstance(err, str) else err
    kind, reason = classify(_status_from_error_obj(err), body)
    return ProviderError(cand, f"{where}: {reason} — {_redacted(body)}", kind)


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


def to_openai_messages(messages: List[ChatMessage]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for m in messages:
        entry: Dict[str, Any] = {"role": m.role or "user", "content": _text_of(m.content)}
        if m.name:
            entry["name"] = m.name
        if m.tool_call_id:
            entry["tool_call_id"] = m.tool_call_id
        if m.tool_calls:
            entry["tool_calls"] = m.tool_calls
        out.append(entry)
    return out


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


def sse_error(message: str) -> str:
    return "data: " + json.dumps(
        {"error": {"message": _redacted(message), "type": "provider_error"}}) + "\n\n"


# ------------------------------------------------------- SSE / body IO ---

_SPLIT_RE = re.compile(r"\r\n\r\n|\n\n")


def _event_data(event: str) -> List[str]:
    out: List[str] = []
    for line in event.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            out.append(line[5:].strip())
    return out


async def _sse_data(resp: httpx.Response) -> AsyncIterator[str]:
    """Yield the `data:` payload of each SSE event (CRLF or LF delimited)."""
    buf = ""
    async for raw in resp.aiter_text():
        buf += raw
        while True:
            m = _SPLIT_RE.search(buf)
            if not m:
                break
            event = buf[:m.start()]
            buf = buf[m.end():]
            for d in _event_data(event):
                yield d
    for d in _event_data(buf):
        yield d


async def _read_body(resp: httpx.Response, limit: int = MAX_ERROR_BODY) -> str:
    try:
        raw = await resp.aread()
    except httpx.HTTPError:
        return ""
    return raw[:limit].decode("utf-8", "replace")


async def _guard_status(cand: Candidate, resp: httpx.Response) -> None:
    """Raise a classified ProviderError for any non-200 upstream response."""
    if resp.status_code == 200:
        return
    body = await _read_body(resp)
    kind, reason = classify(resp.status_code, body)
    raise ProviderError(cand, f"HTTP {resp.status_code} {reason} — {_redacted(body)}",
                        kind, resp.status_code)


_ERR_TYPES = ("error", "provider_error", "upstream_error", "api_error")
_ERR_CODES = ("upstream_error", "error", "billing_error", "invalid_api_key")


def _frame_error(cand: Candidate, payload: Dict[str, Any]) -> Optional[Any]:
    """Aggregators report failures with HTTP 200 in several shapes; catch them all."""
    if payload.get("error"):
        return payload.get("error")
    if payload.get("object") == "error" or payload.get("type") in _ERR_TYPES \
            or payload.get("code") in _ERR_CODES:
        return payload
    return None


def _openai_delta(cand: Candidate, payload: Dict[str, Any]) -> str:
    """Pull the text delta out of one OpenAI-shaped SSE frame.

    Raises ProviderError for aggregator error frames that arrive with HTTP 200
    (very common: {"error": {...}} or {"message": ..., "type": "provider_error"}
    inside a 200 SSE stream).
    """
    err = _frame_error(cand, payload)
    if err is not None:
        raise _error_from_obj(cand, err, "stream frame error")
    choices = payload.get("choices") or []
    if not choices:
        # No choices + a human-readable message and no usage block = error frame.
        if isinstance(payload.get("message"), str) and not payload.get("usage"):
            raise _error_from_obj(cand, payload, "stream frame error")
        return ""  # usage-only / keepalive frame
    ch = choices[0] if isinstance(choices[0], dict) else {}
    for src in (ch.get("delta"), ch.get("message"), ch):
        if not isinstance(src, dict):
            continue
        content = src.get("content")
        if isinstance(content, str) and content:
            return content
        if isinstance(content, list):  # content parts
            text = "".join(str(p.get("text", "")) for p in content
                           if isinstance(p, dict) and p.get("text"))
            if text:
                return text
    return ""


def _nonstream_text(cand: Candidate, body: str) -> str:
    """Extract text from a buffered (non-SSE) body, error or nothing."""
    stripped = (body or "").strip()
    if not stripped:
        raise ProviderError(cand, "empty response body", ROTATE)
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        return stripped  # plain text answer
    if isinstance(data, dict) and data.get("error"):
        raise _error_from_obj(cand, data.get("error"), "HTTP 200 error body")
    if isinstance(data, dict) and isinstance(data.get("candidates"), list):
        return _gemini_text(cand, data)
    if isinstance(data, dict) and not data.get("choices") and isinstance(data.get("message"), str):
        raise _error_from_obj(cand, data, "HTTP 200 error body")
    choices = (data.get("choices") or []) if isinstance(data, dict) else []
    for ch in choices:
        if not isinstance(ch, dict):
            continue
        for src in (ch.get("message"), ch.get("delta"), ch):
            if isinstance(src, dict):
                text = src.get("content")
                if isinstance(text, str) and text:
                    return text
    raise ProviderError(cand, "no content in HTTP 200 response body", ROTATE)


# ------------------------------------------------------------ providers ---

def _openai_payload(cand: Candidate, req: ChatRequest, stream: bool,
                    max_tokens: int) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "model": cand.model,
        "messages": to_openai_messages(req.messages),
        "temperature": max(0.0, min(2.0, req.temperature)),
        "max_tokens": max_tokens,
        "stream": stream,
    }
    if req.tools:
        payload["tools"] = req.tools
    if req.tool_choice:
        payload["tool_choice"] = req.tool_choice
    return payload


def _clamp_openai_tokens(cand: Candidate, req: ChatRequest) -> int:
    if cand.model.startswith("gemini"):
        return max(1, min(8192, req.max_tokens or 4096))
    return max(2048, min(16384, req.max_tokens or 4096))


async def stream_candidate(client: httpx.AsyncClient, cand: Candidate,
                           req: ChatRequest) -> AsyncIterator[str]:
    """Yield raw text deltas from one candidate. Raises ProviderError otherwise."""
    if cand.kind == "gemini":
        url = f"{cand.base_url}/models/{cand.model}:streamGenerateContent?alt=sse"
        headers = {"x-goog-api-key": cand.api_key, "Content-Type": "application/json",
                   "Accept": "text/event-stream"}
        json_body: Dict[str, Any] = to_gemini_payload(req.messages, req.temperature,
                                                      req.max_tokens)
    else:
        url = f"{cand.base_url}/chat/completions"
        headers = {"Content-Type": "application/json",
                   "Authorization": f"Bearer {cand.api_key}",
                   "Accept": "text/event-stream"}
        json_body = _openai_payload(cand, req, True, _clamp_openai_tokens(cand, req))

    try:
        request = client.build_request("POST", url, headers=headers, json=json_body)
        resp = await client.send(request, stream=True)
    except httpx.HTTPError as e:
        raise ProviderError(cand, f"network error: {type(e).__name__}: {e}",
                            ROTATE, None)

    try:
        await _guard_status(cand, resp)
        ctype = (resp.headers.get("content-type") or "").lower()
        if "text/event-stream" not in ctype:
            # Some gateways answer a stream request with one JSON document.
            yield _nonstream_text(cand, await _read_body(resp, MAX_JSON_BODY))
            return
        async for data in _sse_data(resp):
            if not data or data == "[DONE]":
                if data == "[DONE]":
                    return
                continue
            try:
                payload = json.loads(data)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            if cand.kind == "gemini":
                text = _gemini_delta(cand, payload)
            else:
                text = _openai_delta(cand, payload)
            if text:
                yield text
    except ProviderError:
        raise
    except httpx.HTTPError as e:
        raise ProviderError(cand, f"network error: {type(e).__name__}: {e}", ROTATE, None)
    finally:
        await resp.aclose()


async def call_candidate(client: httpx.AsyncClient, cand: Candidate,
                         req: ChatRequest) -> str:
    """One-shot (non-streaming) completion from a single candidate."""
    if cand.kind == "gemini":
        url = f"{cand.base_url}/models/{cand.model}:generateContent"
        headers = {"x-goog-api-key": cand.api_key, "Content-Type": "application/json"}
        json_body = to_gemini_payload(req.messages, req.temperature, req.max_tokens)
    else:
        url = f"{cand.base_url}/chat/completions"
        headers = {"Content-Type": "application/json",
                   "Authorization": f"Bearer {cand.api_key}"}
        json_body = _openai_payload(cand, req, False, _clamp_openai_tokens(cand, req))

    try:
        r = await client.post(url, headers=headers, json=json_body)
    except httpx.HTTPError as e:
        raise ProviderError(cand, f"network error: {type(e).__name__}: {e}", ROTATE, None)
    await _guard_status(cand, r)  # reads the body on failure
    if cand.kind == "gemini":
        try:
            return _gemini_text(cand, r.json())
        except ValueError as e:
            raise ProviderError(cand, f"unexpected response shape: {e}", ROTATE)
    return _nonstream_text(cand, r.text)


def _gemini_text(cand: Candidate, resp: Dict[str, Any]) -> str:
    if isinstance(resp, dict) and resp.get("error"):
        raise _error_from_obj(cand, resp.get("error"), "HTTP 200 error body")
    cands = (resp.get("candidates") or []) if isinstance(resp, dict) else []
    if not cands:
        fb = (resp.get("promptFeedback") or {}) if isinstance(resp, dict) else {}
        reason = fb.get("blockReason") or ""
        if reason:
            raise ProviderError(cand, f"blocked by upstream ({reason})", STOP)
        raise ProviderError(cand, "no candidates in response", ROTATE)
    parts = ((cands[0].get("content") or {}).get("parts")) or []
    text = "".join(p.get("text", "") for p in parts
                   if isinstance(p, dict) and p.get("text"))
    if not text:
        finish = cands[0].get("finishReason", "unknown")
        kind = STOP if str(finish).upper().startswith(("SAFETY", "PROHIBITED", "BLOCKLIST", "SPII", "RECITATION")) else ROTATE
        raise ProviderError(cand, f"empty text (finish={finish})", kind)
    return text


def _gemini_delta(cand: Candidate, chunk: Dict[str, Any]) -> str:
    if chunk.get("error"):
        raise _error_from_obj(cand, chunk.get("error"), "stream frame error")
    cands = chunk.get("candidates") or []
    if not cands:
        return ""
    finish = str(cands[0].get("finishReason") or "")
    if finish.upper().startswith(("SAFETY", "PROHIBITED", "BLOCKLIST", "SPII", "RECITATION")):
        raise ProviderError(cand, f"content blocked by upstream ({finish})", STOP)
    parts = ((cands[0].get("content") or {}).get("parts")) or []
    text = "".join(str(p.get("text", "")) for p in parts
                   if isinstance(p, dict) and p.get("text") and not p.get("thought"))
    if text:
        return text
    content = cands[0].get("content")
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, dict) and content.get("text"):
        return str(content.get("text"))
    return ""


# ------------------------------------------------- retry + failover ---

async def _open_first_token(client: httpx.AsyncClient, cand: Candidate,
                            req: ChatRequest) -> Tuple[AsyncIterator[str], str]:
    """Start a candidate and wait for its first text delta.

    Raises ProviderError when the candidate cannot deliver one, so the caller can
    rotate to the next model *before* a single byte reaches the client.
    """
    gen = stream_candidate(client, cand, req)
    try:
        first = await asyncio.wait_for(gen.__anext__(), timeout=FIRST_TOKEN_TIMEOUT)
    except StopAsyncIteration:
        await _aclose(gen)
        raise ProviderError(cand, "stream ended with no content", ROTATE)
    except asyncio.TimeoutError:
        await _aclose(gen)
        raise ProviderError(cand, f"no first token within {FIRST_TOKEN_TIMEOUT:.0f}s",
                            ROTATE)
    except BaseException:
        await _aclose(gen)
        raise
    if not first:
        await _aclose(gen)
        raise ProviderError(cand, "first chunk was empty", ROTATE)
    return gen, first


async def _aclose(gen) -> None:
    try:
        await gen.aclose()
    except (RuntimeError, StopAsyncIteration, GeneratorExit, asyncio.CancelledError):
        pass
    except Exception:  # pragma: no cover - best effort cleanup
        logger.debug("aclose failed", exc_info=True)


# --------------------------------------------------------------- routes ---

@app.get("/")
async def root():
    return {"service": "sandra-ai-backend", "status": "ok",
            "providers": list(DEFAULT_ORDER),
            "docs": "POST /v1/chat/completions with {messages, model?, temperature?, max_tokens?, stream?}"}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "chain": [f"{name}/{m}" for name in DEFAULT_ORDER
                  for m in REGISTRY[name]["models"] if REGISTRY[name]["key"]],
        "providers": {
            name: {"configured": bool(REGISTRY[name]["key"]),
                   "base_url": REGISTRY[name]["base"],
                   "models": REGISTRY[name]["models"]}
            for name in DEFAULT_ORDER
        },
        "max_retries_per_candidate": MAX_RETRIES_PER_PROVIDER,
        "first_token_timeout": FIRST_TOKEN_TIMEOUT,
        "cors_allow_all": CORS_ALLOW_ALL,
        "cors_origins": FRONTEND_ORIGINS,
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest):
    if not req.messages:
        raise HTTPException(status_code=400, detail="messages is required")
    cid = "chatcmpl-" + uuid.uuid4().hex[:12]
    rid = uuid.uuid4().hex[:8]
    if req.stream:
        return await _stream_route(req, cid, rid)
    return await _json_route(req, cid, rid)


def _headers(cand: Candidate, rid: str) -> Dict[str, str]:
    return {"X-Sandra-Provider": cand.provider, "X-Sandra-Model": cand.model,
            "X-Sandra-Rid": rid}


def _failure_report(failures: Dict[str, str], last: Optional[ProviderError]) -> JSONResponse:
    """Always report a provider outage as 502 — a provider's 401/403/billing
    failure is not a status the browser should ever see."""
    status = 502
    if last is not None and last.kind == STOP and last.status and 400 <= last.status < 500:
        status = last.status
    if not failures:
        message = ("No AI provider is configured — set CLEAN_API_KEY, GEMINI_API_KEY "
                   "or OPENCODE_API_KEY on the server.")
        status = 503
    else:
        message = "All providers failed: " + "; ".join(
            f"{k} {v}" for k, v in failures.items())
    return JSONResponse(
        {"error": {"message": message, "type": "provider_error",
                   "providers": failures}},
        status_code=status)


def _note(e: ProviderError) -> str:
    return {"rotate": "rotating", SKIP_PROVIDER: "skipping provider",
            STOP: "stopping"}.get(e.kind, "rotating")


async def _json_route(req: ChatRequest, cid: str, rid: str) -> JSONResponse:
    failures: Dict[str, str] = {}
    last: Optional[ProviderError] = None
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        for _provider, cands in build_groups(req):
            for cand in cands:
                try:
                    text = await _attempt(client, cand, req, rid)
                except ProviderError as e:
                    last = e
                    failures[cand.label] = _redacted(e.message)
                    logger.warning("[%s] %s %s: %s", rid, cand.label, _note(e),
                                   _redacted(e.message))
                    if e.kind == STOP:
                        return _failure_report(failures, e)
                    if e.kind == SKIP_PROVIDER:
                        break  # abandon this provider's other models
                    continue
                logger.info("[%s] %s answered", rid, cand.label)
                return JSONResponse(openai_completion(cid, cand.model, text),
                                    headers=_headers(cand, rid))
    return _failure_report(failures, last)


async def _attempt(client: httpx.AsyncClient, cand: Candidate, req: ChatRequest,
                   rid: str) -> str:
    """Call a candidate, retrying in place only for network-level failures."""
    for attempt in range(MAX_RETRIES_PER_PROVIDER + 1):
        try:
            return await call_candidate(client, cand, req)
        except ProviderError as e:
            network = "network error" in e.message
            if not network or attempt >= MAX_RETRIES_PER_PROVIDER:
                raise
            logger.warning("[%s] %s network retry %d/%d", rid, cand.label,
                           attempt + 1, MAX_RETRIES_PER_PROVIDER)
            await asyncio.sleep(0.5 * (2 ** attempt))
    raise ProviderError(cand, "unreachable")  # pragma: no cover


async def _stream_route(req: ChatRequest, cid: str,
                        rid: str) -> StreamingResponse | JSONResponse:
    """Resolve a working candidate BEFORE the 200 headers go out."""
    failures: Dict[str, str] = {}
    last: Optional[ProviderError] = None
    client = httpx.AsyncClient(timeout=HTTP_TIMEOUT)
    chosen: Optional[Candidate] = None
    gen: Optional[AsyncIterator[str]] = None
    first = ""
    for _provider, cands in build_groups(req):
        skip_provider = False
        for cand in cands:
            if skip_provider:
                break
            for attempt in range(MAX_RETRIES_PER_PROVIDER + 1):
                try:
                    gen, first = await _open_first_token(client, cand, req)
                    chosen = cand
                    break
                except ProviderError as e:
                    last = e
                    failures[cand.label] = _redacted(e.message)
                    # Only network blips are retried in place; quota / model
                    # unavailability rotates to a DIFFERENT model straight away.
                    network = "network error" in e.message
                    logger.warning("[%s] %s %s: %s", rid, cand.label,
                                   "retrying" if network else _note(e),
                                   _redacted(e.message))
                    if e.kind == SKIP_PROVIDER:
                        skip_provider = True
                    if e.kind != ROTATE or not network or attempt >= MAX_RETRIES_PER_PROVIDER:
                        break
                    await asyncio.sleep(0.5 * (2 ** attempt))
            if chosen is not None or last is not None and last.kind == STOP:
                break
        if chosen is not None or last is not None and last.kind == STOP:
            break

    if chosen is None or gen is None:
        await client.aclose()
        return _failure_report(failures, last)

    logger.info("[%s] streaming via %s", rid, chosen.label)
    return StreamingResponse(
        _stream_body(client, gen, first, chosen, cid),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive", **_headers(chosen, rid)},
    )


async def _stream_body(client: httpx.AsyncClient, gen: AsyncIterator[str],
                       first: str, cand: Candidate,
                       cid: str) -> AsyncIterator[str]:
    """Forward deltas; a failure here can no longer fail over, so just report it."""
    try:
        yield openai_chunk(cid, cand.model, first)
        async for text in gen:
            if text:
                yield openai_chunk(cid, cand.model, text)
        yield openai_chunk(cid, cand.model, "", finish="stop")
        yield "data: [DONE]\n\n"
    except (GeneratorExit, asyncio.CancelledError):
        raise
    except ProviderError as e:
        logger.warning("stream from %s broke after first token: %s", cand.label,
                       _redacted(e.message))
        yield sse_error(f"{cand.label}: {e.message}")
        yield "data: [DONE]\n\n"
    except Exception as e:  # pragma: no cover - defensive
        logger.exception("stream from %s crashed", cand.label)
        yield sse_error(f"{cand.label}: {type(e).__name__}: {e}")
        yield "data: [DONE]\n\n"
    finally:
        await _aclose(gen)
        await client.aclose()
