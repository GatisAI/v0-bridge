# Test evidence and verification boundary

Date: 2026-10-15 UTC. Machine-readable sanitized results: [test-results.json](test-results.json).

## Verified

- Native Node Web Standard handler layout/config researched against official Vercel docs. Source/config import check passes.
- **25 offline unit tests pass** on Node22.23.3 and Node24.14.1: authentication/rotation identity, model list, namespace/custom tools, schema validation, history/cache, cache_control regression, prefix fork rejection, effort/unsupported inputs, SSE order, session isolation, lock/safeguard behavior, production memory-store rejection.
- Real Redis7.4.2 tested through a local REST adapter: persistent state across new store instances, Lua ownership lock/release, daily reservations, response-id/cache/continuation.
- **Hosted Upstash REST** separately tested with a temporary database: JSON commands, EVAL, wrong-owner unlock rejected, parallel reservation atomicity, Redis persistence across new store objects, cached response identity, previous_response_id continuation. Its v0 upstream was mocked; those integration tests spend no v0 credits. No hosted database credentials are shipped.
- Dependency audit: **0 known production dependency vulnerabilities** at time of test. This is not a security audit or future guarantee.

## Actual v0 + real coding clients through Node bridge

These are not mocked client executors. Clients ran actual local Read/Edit/Write/Bash/patch/exec tools, extended seeded SQLite inventory projects with Inventory.summary + JSON CLI, added tests, ran them, then resumed after the Node server process was stopped/restarted.

| Check | Codex0.162.1 + Astra | Claude Code2.1.301 + Fable |
|---|---:|---:|
| Full project test suite after extension | 57pass | 42pass |
| Independent summary acceptance tests | 5pass | 5pass |
| Same client thread/session after restart | Pass | Pass |
| Same upstream v0 chat for that client session | Pass | Pass |
| Real file edit + test command after restart | Pass | Pass |
| Recalled random earlier marker without rereading | Pass | Pass |
| Client-reported SHA256 matched actual source file | Pass | Pass |

Seed projects were from earlier Python bridge tests: Codex started with47tests, Claude35. This Node validation added10and7tests respectively; it was **not** a fresh from-scratch project benchmark. Independent tests are outside the project and not provided to the coding clients. The bridge author did not edit their project implementation to make acceptance pass.

An initial Node port rejected Claude's thinking config too strictly before upstream work. Fixed by accepting recognized config as compatibility metadata, **without claiming native thinking control**; the actual successful test was rerun after the fix. Request headers/docs disclose the limitation. Native signed thinking blocks remain unsupported.

Initial live tests used Node24.14.1; post-restart client and chat checks used Node22.23.3, matching the repository's Vercel engine target. Codex test-only sandbox disabled due test-host bwrap incompatibility; the shipped user launcher keeps workspace-write sandbox/on-request permissions. User launcher reviewed for Windows, not executed on Windows.

## Ordinary chat / official SDKs with actual v0

- OpenAI Chat Completions: Astra and Opus.
- OpenAI Responses: Sol.
- Anthropic Messages: Fable.
- All4initial marker replies matched exact expected values.
- After Node process restart: Astra full-history chat and Sol previous_response_id both recalled their exact earlier markers.
- `/v1/models` serves the four configured IDs. Listing is static, not proof any arbitrary model ID will be accepted by an upstream account.

Live CLI tests used real local Redis via a REST adapter. Hosted Upstash command/locking compatibility was tested separately. Actual v0 credentials and temporary hosted credentials are never embedded in this repo.

## NOT verified / not claimed

- **No public Vercel deployment was created/tested.** The user's Vercel account/project/domain are not connected here. GitHub import/deploy remains a user step. Local success is not a remote deployment certificate.
- `npm run build` is an import/config validation, not `vercel build` with a linked project. Vercel packages native functions during deploy.
- No full OpenAI/Anthropic feature parity; no native function-calling upstream; no raw/base-model access.
- Effort only prompt hint; hard output-token budget not enforced; buffered SSE, no native token stream.
- No high-concurrency soak test, unlimited-context claim, long-term billing reconciliation or professional security audit.
- Env-based key rotation is not instantaneous revoke on old deployments/in-flight work.

## Reproduce offline/Redis checks

```bash
npm ci
npm test
npm run build
```

Optional integration using your **test** Upstash database (may consume Redis operations, never v0 credits):

```bash
TEST_REDIS_REST_URL=https://YOUR_TEST_DB.upstash.io \
TEST_REDIS_REST_TOKEN=YOUR_TEST_TOKEN npm run test:integration
```

Or start local Redis, run `node test/redis-rest-proxy.mjs`, then `npm run test:integration`. Local proxy defaults127.0.0.1:6399 forwarding Redis127.0.0.1:6398. Do not expose the test proxy publicly. Integration namespaces are unique; mock test records expire on the configured TTL.

## Deployment smoke test

After import and setting env: check authenticated model list, one ordinary chat, then one real small coding request. Verify chat continuation on a stable X-V0-Session and check your v0 history/billing. Check the Function logs if timeout/state errors occur; do not blindly retry paid generations. Use a private/unshared key during initial deployment testing.

## v0.2 landing/setup regression

- 25 unit tests include no-env first deploy, missing-PIN open candidate generation, configured PIN checks, inactive->env-activated key transition, configuration status secret redaction, env-configured model allowlist/aliases, client registry-injection rejection, local dotenv serialization/invalid input rejection.
- 18 portable browser smoke checks pass: setup visibility, PIN states, inactive key generation, model/code tabs, local .env download, no form-secret POST/no browser storage, FAQ, mobile horizontal overflow. Browser configured-status/PIN responses mocked for UI states; backend PIN activation/status cases separately tested in unit tests.
- Export .env tested with Node22 native --env-file parser; model JSON and empty multikey override round-trip correctly.
- Actual Codex and Claude Code re-resumed existing Redis-backed v0 sessions after landing/model-env integration. Real local tools reran57and42tests, recalled original markers without reread, and reported SHA256 matching actual source. This is separate from original v0.1 initial/resume tests above.
- Desktop, mobile390px, dark-mode, setup, PIN error/key result and env confirmation inspected visually. No professional security audit or public Vercel deployment claimed.

UI reproduction: `npm ci`, then `npx playwright install chromium`, then `npm run test:ui`. On a machine with Chromium already installed, use `CHROMIUM_PATH=/path/to/chromium npm run test:ui`. Offline UI tests use dummy values and no v0 credits.
