# Upstream create-stream completion hotfix

## Scope and diagnosis
Baseline: `abb7d3811e6b7c59a25e0f30b8bcd360231fbfc3` (main).

A real v0 v2 create-stream capture emitted a chat snapshot, message-parts chunks, message usage, and a closing chat snapshot. It did not emit the terminal `object: message` expected by the old parser. The old parser consequently rejected an otherwise completed generation. This is an upstream stream-shape mismatch, not proof of a Redis or client configuration error.

## Runtime changes
- Preserve support for streams containing a terminal message.
- After normal create-stream EOF with known chat/message IDs and completion evidence (closing chat snapshots or usage), reconcile through the official GET message endpoint.
- Require an authoritative assistant message with matching IDs and a finishReason; EOF/usage alone never counts as success.
- Poll pending messages within configured wait and request deadlines. Never replay a generation POST automatically.
- Preserve non-stop finish reasons and cancellation/error handling.
- Classify the specifically observed upstream HTTP403 rate-limit JSON as HTTP429. Ordinary permission403 remains an upstream failure; private upstream error bodies are not exposed.

## Files and deployment
Only **src/upstream.js** is required for the runtime fix. Also upload test/upstream.test.js and these docs to keep the repository's regression evidence current.

1. Back up your current src/upstream.js, or retain the previous Git commit.
2. Compare this patch against your current code. It was built against the baseline above; do not overwrite newer unrelated changes blindly.
3. Replace src/upstream.js; upload the test and docs files if desired.
4. Commit to the GitHub branch connected to Vercel and wait for the new Production deployment.
5. No new environment variables, dependencies, Redis flush, namespace change, or state migration are required.
6. Verify model listing, a small streaming response, and a fresh Codex turn followed by a continuation. Check that response.completed is received, not only HTTP200.
7. If regression occurs, revert this hotfix commit. Keep environment/state unchanged during rollback.

GitHub reading succeeded but branch creation was denied403 by the current connection. This package has NOT been pushed or deployed by the test runner.

## Verification
- Baseline existing offline suite: 79 passed.
- The new create-stream regression failed against the original parser and passed against the patch.
- Final source/config check and offline suite: 93 passed, 0 failed (14 added regressions).
- Real local Redis7.4.2 plus REST adapter integration: passed persistence, ownership locks, Lua reservations, independent requests and response lineage. Upstream was mocked in this integration suite.
- Local patched bridge with real v0 upstream: Astra Responses 10/10 simultaneous independent tasks passed. Fable Anthropic Messages 5/10 passed; the other5 hit upstream HTTP403 during creation. This batch preceded the final error-classification change, so its stored bridge failures were generic502.
- A separate direct upstream diagnostic verified the exact403 response was rate limiting, not an inferred permission/billing problem. The final classifier maps that observed response to429; it does not remove the upstream limit. No throughput increase is claimed.
- Final patch, real Codex0.162.1: fresh fixture read via local shell and same-thread resume both completed successfully, with no manual X-V0-Session header.
- Final patch, real v0: Sol and Opus Chat Completions each passed a small exact-answer test (HTTP200).

Live bridge/model/client checks used LOCAL memory state, not hosted Upstash. Redis behavior was tested separately as described above. Production deployment, a new Claude Code CLI run, sustained load, and browser UI were NOT verified in this hotfix checkpoint.

## Still not native API parity
Client-facing text SSE is still buffered. Tool calling remains an adapter/emulation; native reasoning controls, signed thinking, compaction and other unsupported features are not added here. This fix does not eliminate platform body/time limits, upstream context limits or rate limits. Client-owned context and current public model IDs/routes are unchanged. Earlier test reports describing session-owned upstream chats are historical, not this architecture.
