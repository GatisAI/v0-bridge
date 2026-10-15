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
