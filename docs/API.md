# API subset

## Authentication

`Authorization: Bearer YOUR_GATEWAY_KEY` or Anthropic `x-api-key`. Minimum configured key length24characters; use32random bytes/64hex recommended. No CORS wildcard, privileged browser admin, or cookie auth. A separate public setup module exists below. Browser cross-origin apps need an explicitly designed CORS policy or their own backend proxy; do not put a shared private key into public frontend code.

Send `X-V0-Session: unique-and-stable-id` (letters/digits/`_.:-`, max160) to override session routing. Otherwise Responses recognizes Codex thread-id/session-id headers and client_metadata.thread_id/session_id; Anthropic recognizes x-claude-code-session-id and session_id inside JSON metadata.user_id. Native IDs must agree and satisfy the same character/length constraints. Gateway key ID, protocol and model also isolate scopes; session IDs are not authentication credentials. A previous_response_id must belong to the same key/model and match any supplied session identity. Without identity or a response link, each request gets a fresh scope without retry deduplication. Prompt content, cache keys, device/account IDs and request IDs are not session identities. Provider headers are not forwarded as upstream authentication.

## Model naming

Use canonical public IDs: gpt-6-astra, gpt-6.1-sol, claude-fable-5.1, claude-opus-5.5. Both GET /openai/v1/models and GET /v1/models list public IDs. All generation adapters accept those IDs, legacy vendor-prefixed IDs and configured short aliases. The registry maps each to an unchanged upstreamId; upstream reporting is validated against that upstream ID, while client response model fields (including SSE) use the public ID. Unknown names or mismatched upstream models fail without fallback.

MODELS_JSON entries use {id,upstreamId,alias,label}; optional aliases adds explicit compatibility names. Old built-in prefixed entries are normalized automatically. Custom legacy IDs need an explicit publicId or the new entry shape. Duplicate/ambiguous mappings are rejected. Existing version-2 response lineage is compared using normalized upstream identity before generation; changing between aliases does not switch models. See README for the complete mapping and migration policy.

Canonical routes: /openai/v1/chat/completions, /openai/v1/responses, /anthropic/v1/messages. The /v1 routes below remain compatibility aliases.

## Chat Completions

POST `/v1/chat/completions`:

```json
{"model":"gpt-6-astra","messages":[{"role":"user","content":"Hello"}],"stream":false}
```

For follow-up send accumulated user/assistant history and the same session header. Text content only. `tools` uses function/function.parameters convention. `tool_choice` auto/none/required or named tool; `parallel_tool_calls:false` requests one call maximum. The caller must execute returned tool_calls and append tool messages. Never trust generated commands without permission/sandbox review.

## Responses

POST `/v1/responses`:

```json
{"model":"gpt-6-astra","input":"Remember ORCHID"}
```

Then send `{"model":"gpt-6-astra","previous_response_id":"resp_...","input":"What word?"}`. Response history is Redis scoped; previous IDs from another key/session/model are rejected. Caller-defined function/custom tools and namespace wrappers are supported. Native built-ins, item_reference, images/compaction are not. Codex additional_tools items are parsed as tool declarations.

## Anthropic Messages

POST `/v1/messages`:

```json
{"model":"claude-fable-5.1","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}
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
