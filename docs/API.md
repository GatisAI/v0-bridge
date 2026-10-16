# API subset

## Authentication

`Authorization: Bearer YOUR_GATEWAY_KEY` or Anthropic `x-api-key`. Minimum configured key length24characters; use32random bytes/64hex recommended. No CORS wildcard, privileged browser admin, or cookie auth. A separate public setup module exists below. Browser cross-origin apps need an explicitly designed CORS policy or their own backend proxy; do not put a shared private key into public frontend code.

Send `X-V0-Session: unique-and-stable-id` (letters/digits/`_.:-`, max160). API clients may also send standard provider headers; these are not forwarded as authentication to v0.

## Chat Completions

POST `/v1/chat/completions`:

```json
{"model":"astra","messages":[{"role":"user","content":"Hello"}],"stream":false}
```

For follow-up send accumulated user/assistant history and the same session header. Text content only. `tools` uses function/function.parameters convention. `tool_choice` auto/none/required or named tool; `parallel_tool_calls:false` requests one call maximum. The caller must execute returned tool_calls and append tool messages. Never trust generated commands without permission/sandbox review.

## Responses

POST `/v1/responses`:

```json
{"model":"astra","input":"Remember ORCHID"}
```

Then send `{"model":"astra","previous_response_id":"resp_...","input":"What word?"}`. Response history is Redis scoped; previous IDs from another key/session/model are rejected. Caller-defined function/custom tools and namespace wrappers are supported. Native built-ins, item_reference, images/compaction are not. Codex additional_tools items are parsed as tool declarations.

## Anthropic Messages

POST `/v1/messages`:

```json
{"model":"fable","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}
```

Tools use `name`, `description`, `input_schema`; round-trip via assistant tool_use + user tool_result blocks. Transport cache_control metadata is normalized, while same-named fields inside tool arguments are preserved. Native thinking blocks are not supported.

## Streaming and errors

`stream:true`: SDK-compatible buffered SSE event sequences with heartbeat comments or Anthropic ping while waiting. Response headers disclose emulated tools, soft token limits and effort hints. Nonstream success includes `X-V0-Chat-Id` and cache hit/miss headers. Streaming failures after headers return HTTP200 plus an SSE error event, not a later HTTP error status; clients must handle the event.

Typical errors:400invalid/unsupported request,401key invalid,409active/diverged/pending session,413history/request too large,429rate/soft safeguard/upstream limit,502upstream/model/envelope failure,503Redis/config failure,504deadline/poll timeout. No unbounded HTTP retry is performed upstream.

`/health` public liveness; `/v1/bridge/capabilities` and `/v1/models` authenticated. All response/API outputs use no-store. Sensitive metadata/history must not be publicly cached.

**Thinking request compatibility:** Claude Code may insist on a thinking/adaptive config for some model IDs even with compatibility flags. The adapter accepts recognized thinking configs for transport compatibility, but does not forward a native thinking budget or return signed native thinking blocks. Header `X-V0-Thinking-Control` discloses this. Do not interpret successful requests as native thinking-control support.

## Landing / setup (no API-key activation)

- GET `/`: landing/tutorials/first-run ENV Generator.
- GET `/setup/status`: public configured/setupRequired/pinRequired flags + model metadata; no server credentials.
- POST `/setup/generate-key`: JSON `{}` when no ADMIN_PIN; JSON `{"pin":"..."}` when set. Returns `{key,active:false,message}`. Never edits env/Redis, activates keys, or retrieves existing key values. Wrong PIN401; best-effort per-instance throttle429; cross-origin requests403.

Core configuration means v0 key, valid active gateway key mapping, HTTPS Redis URL + token and valid model allowlist are present. This is NOT an upstream connectivity test. Setup form hides when complete. Candidate key still needs env update + redeploy. No `/api` prefix needed in public API URLs.

## Request and state limits

Limits are measured in UTF-8 bytes. Missing or empty settings use defaults; invalid nonempty settings fail with HTTP 503 rather than silently reverting.

| Setting | Default | Allowed range |
| --- | ---: | ---: |
| MAX_REQUEST_BODY_BYTES | 4000000 | 1024-4500000 |
| MAX_RAW_STATE_BYTES | 8000000 | 1024-32000000 |
| MAX_STORED_STATE_BYTES | 9000000 | 1024-9900000 |
| MAX_REDIS_REQUEST_BYTES | 10000000 | 2048-10000000 |
| MAX_REQUESTS_PER_MINUTE | 60 | 1-10000 |
| REQUEST_DEADLINE_SECONDS | 250 | 10-250 |
| V0_WAIT_SECONDS | 110 | 10-240 |
| V0_POLL_MS | 2000 | 20-10000 |

The request default leaves headroom below Vercel's documented 4.5 MB function payload limit; configuration cannot bypass platform limits. The Redis command limit includes JSON escaping and command overhead, not just the stored value. Upstash's published basic-plan request limit is 10 MB; verify the limits of your actual plan. References: https://vercel.com/docs/functions/limitations and https://upstash.com/pricing/redis.md.

State writes use gzip + base64 with a gz: prefix only when smaller than plain JSON. Reads support both original JSON and gz: hotfix records, with bounded decompression. Keep the same namespace and session identifiers when upgrading. Rollback requires a gzip-aware reader; the original JSON-only reader cannot read newly compressed records. No migration or deletion of existing records is performed.

Pending state is size-checked before reserving a generation or sending an upstream request. An oversized pending state leaves the existing session unchanged. This is not a guarantee that future output will fit: generated output and upstream identifiers are unknown at preflight. Completed state and Responses history are checked before completion writes; later storage/network failures still mark the session failed when possible. Do not blindly retry pending/failed sessions. Completion writes are not a multi-key transaction.

Size logs contain numeric byte counts and boolean flags, never request content. Gzip does not compact model context, shorten history, or enable automatic rollover. Semantic compaction remains unsupported; start a new session with an explicit summary when needed.

The session generation cap also applies to envelope repair. Daily reported-cost limits are safeguards based on reported usage, not a hard prepaid budget. Per-minute rate limiting uses Redis; the local-only MemoryStore does not enforce it.
