# v0 bridge · Vercel + Redis + first-run setup

Experimental **Node.js** adapter for **v0 API v2**. Public landing with tutorials, PIN-gated **inactive key generation**, browser-only ENV Generator, OpenAI/Anthropic-style API subsets, Redis sessions. No customer admin dashboard, Supabase, or automatic API-key activation.

**Billing stays on v0, not Vercel AI Gateway.** Upstream v0 context still exists; this is not raw/base-model access. Tools are emulated JSON; streams buffered. See limitations below.

## Fastest start: repo → landing → env → redeploy

1. Upload this folder's contents to GitHub, including `.gitignore` and `.env.example`. Never upload a real `.env`, CLI homes, or live Redis state.
2. Import to Vercel, **Framework: Other**, root=repository root, build=`npm run build`. Native `/api` Function; no frontend output-directory override required. Node22 is configured. `public/**` assets are included in the Function bundle.
3. **Deploy without env first.** Landing works without v0/Redis/PIN. The API itself is not ready until secrets are configured.
4. Open the deployed site. Click **Generate API key**. With no `ADMIN_PIN`, generation is open; it creates a random **inactive candidate only**. No default123456. If `ADMIN_PIN` exists, the server requires its exact value.
5. Create/connect **Upstash Redis** via Vercel Marketplace or Upstash console. Get its HTTPS REST URL and **read/write REST token**, not a read-only token. If integration env names differ, copy values to the exact names in the form.
6. Fill **ENV Generator**: v0 key, candidate gateway key, optional new PIN, Redis config, models and retention. Validate → confirm → download `.env` or copy. This happens locally in your browser; values are not uploaded/saved by the generator.
7. In **Vercel Project → Environment Variables**, import if your UI offers it or paste/add the generated variables; scope them to **Production**, Save, then **Redeploy**. Do not commit the downloaded file to GitHub. If switching from multikey mode, remove/empty old `GATEWAY_KEYS_JSON`; the export includes an empty entry for this purpose.
8. Open the current Production domain. Setup form is hidden when core config is present/valid; landing/docs/key generation remain. Click **Tes key & model list** (no v0 spend). Then explicitly choose **Tes chat** (uses v0 credits).

Status only checks configuration presence/basic format, not provider connectivity. `/health` is liveness, not readiness. An old deployment retains its old env. If setup still appears, verify Production env, model JSON, Redis HTTPS URL, and that you actually redeployed.

## What's public, what's secret

- Public: landing/docs, `/health`, `/setup/status` (booleans + model IDs/labels), inactive-key generator.
- Secret server env: `V0_API_KEY`, active gateway key(s), optional `ADMIN_PIN`, Redis token.
- `/setup/status` NEVER returns server secret values.
- `/setup/generate-key` POST only returns a newly generated inactive candidate. It never edits env/DB/active keys, spends v0 credits, or retrieves existing keys.
- The ENV Generator uses in-memory browser form values only: no localStorage/sessionStorage/autosave/analytics/third-party scripts. Refresh/close clears inputs. Export file/clipboard contain secrets: handle them privately.
- Setup form is a convenience UI, not an admin authorization boundary. Its HTML/JS is public; hiding it does not protect any server secret because secrets are never hydrated into it.
- PIN only gates candidate generation. Even a guessed PIN grants no activation, history, Redis config, or secret-reading privileges. Best-effort per-instance generation rate limit, not distributed brute-force protection. Use a long random PIN; use proper auth if adding privileged admin actions later.

## API URLs (no /api prefix for users)

| Endpoint | Use |
|---|---|
| `GET /v1/models` | Env-configured model allowlist |
| `POST /v1/chat/completions` | Text chat / caller-defined tools |
| `POST /v1/responses` | Responses subset / Codex adapter |
| `POST /v1/messages` | Messages subset / Claude Code adapter |
| `GET /v1/bridge/capabilities` | Explicit limitations |

OpenAI base=`https://YOUR_DOMAIN/v1`; Anthropic base=`https://YOUR_DOMAIN`. All `/v1` routes require `Authorization: Bearer GATEWAY_KEY` or `x-api-key`. Source lives in `api/gateway.js` because Vercel uses a Function directory; rewrites keep public URLs at `/v1/...`.

See [API](docs/API.md), [coding clients](docs/CLIENTS.md), [testing](docs/TESTING.md), [security](SECURITY.md).

## Env activation / revoke / rotate

Single key: `GATEWAY_API_KEY`. Multikey mode optionally replaces it:

```dotenv
GATEWAY_KEYS_JSON='{"main":"random-long-key-at-least-24-characters","friend":"another-random-key-at-least-24-characters"}'
```

Create candidates on landing or locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Add to env and redeploy to activate. Remove entry to revoke; replace value **while retaining stable ID** to rotate without changing session scope. Default single-key ID is `main`.

**Not instant revoke:** in-flight requests and old deployments can retain old access. Restrict/delete historical deployments or enable Deployment Protection. If the upstream v0 credential leaked, revoke it with v0 too.

## Models from env

Public client IDs have no vendor prefix. The bridge uses explicit mappings, not prefix stripping or model fallback:

| Public ID | Exact upstream  ID | Short alias |
|---|---|---|
| gpt-6-astra | openai/gpt-6-astra | astra |
| gpt-6.1-sol | openai/gpt-6.1-sol | sol |
| claude-fable-5.1 | anthropic/claude-fable-5.1 | fable |
| claude-opus-5.5 | anthropic/claude-opus-5.5 | opus |

The final MODELS_JSON format is an array of {id, upstreamId, alias, label}, with optional aliases (array). See .env.example for all four entries. Omitting MODELS_JSON keeps these defaults. The browser ENV Generator exports this same canonical format.

Migration: existing string entries and {id,alias,label} entries using any of the four old prefixed IDs are normalized automatically in memory; no Production env write is required. Public IDs, old prefixed IDs, and configured short aliases resolve to the same model. Explicitly configured aliases are preserved. Catalogs, examples and top-level client response model fields use canonical public IDs. Diagnostic billing metadata retains exact upstream IDs for auditing.

For an unknown custom legacy model, supply an explicit public name: {"id":"custom-model","upstreamId":"vendor/exact-model","alias":"custom"}, or retain the old id with {"id":"vendor/exact-model","publicId":"custom-model","alias":"custom"}. The bridge deliberately does not guess a public name from an arbitrary prefix. Duplicate or ambiguous IDs/aliases/upstream mappings cause a configuration error; unknown requested models fail before generation. Built-in mappings cannot be reassigned to another model.

Both /openai/v1/models and /v1/models list this allowlist, not live upstream availability. Every adapter sends upstreamId unchanged to  and validates the reported model against upstreamId. A mismatch is rejected without retry/fallback. Response lineage normalizes model identity before comparison; existing version-2 records using prefixed names remain usable, with the same key ID, namespace and retention. Older record versions still require explicit history under the existing client-owned-history policy; model naming does not add a new invalidation. This engine has no response cache or shared upstream session lookup; alias changes do not create one.

Use public IDs in clients, for example model="gpt-6-astra". For custom allowlists, pass a listed public ID with the launcher's --model option. Changing only the alias does not change the upstream model.

## Why Redis remains

A unique stable `X-V0-Session` + stable gateway key ID + model + protocol maps to one chat v0. Redis stores mapping, full client history, response IDs, retry cache, distributed session lock and UTC daily safeguard counters. **No active gateway secret key list is stored in Redis.**

Default retention is 48 hours (`STATE_TTL_SECONDS=172800`). Expired mappings cannot guarantee resume. Keep namespace unchanged across redeploys; use unique namespaces for Production/Preview/untrusted forks. Clearing/forking history with an existing session causes 409. Explicit X-V0-Session takes precedence; choose a new value for independent sessions or forks, including with the launcher. Otherwise Responses recognizes Codex thread-id/session-id headers or client_metadata.thread_id/session_id; Anthropic recognizes x-claude-code-session-id or session_id inside JSON metadata.user_id. Conflicting or invalid native IDs are rejected. Responses can restore scope via previous_response_id, but any supplied identity and model must match. Without identity or a response link, every request receives a fresh scope without retry deduplication. Prompt content, cache keys and request IDs never merge conversations. Existing explicit-session mappings remain compatible; old content-derived mappings are not automatically adopted by native IDs.

Redis stores full histories/tool results; secure credentials/access. Long Responses snapshots may use substantial storage. Free-tier capacity is provider-dependent, not a promise of unlimited coding requests. No Supabase needed for this version.

## Limitations / safeguards

- Emulated tool envelopes validated structurally, local actions executed by client. One repair attempt maximum. Not native upstream function calling. Detected internal v0 tools cause rejection **after** generation, not a sandbox guarantee.
- Buffered SSE + heartbeat, not native token streaming.
- Effort is a prompt hint. Recognized thinking configs accepted only for transport compatibility, not forwarded native budgets/signed thinking blocks. Hard output token caps not enforced. No images/compaction/sampling/full parity.
- Timeout/disconnect can leave paid v0 work running. Failed/pending sessions blocked409, not blindly retried. No automatic pending-generation recovery/exactly-once billing guarantee.
- Default Vercel maxDuration300s, internal deadline250s, per-generation wait110s. Heartbeats don't extend duration. For a supported Pro configuration increase Function duration and leave at least30s margin; don't raise beyond plan limits.
- Default soft safeguards:200generation reservations/day, reported-cost30/day,100generations/session,60API calls/min/key. Costs are reported upstream values, not a verified dollar ledger. Concurrent/already-started work can overshoot; failed reservations stay counted. Not a hard spending cap/customer quota system.

## Local / CI

```bash
npm ci
npm run dev     # first-run landing at localhost:8787, no env required
npm run check   # import/config validation + offline unit tests; no v0 spend
```

Copy `.env.example` to `.env` and fill secrets for live calls. Never publish it. Optional `STATE_BACKEND=memory` is local-only and still bills v0; production rejects it. `npm run test:integration` uses a test Redis; see TESTING.md. `npm run test:ui` uses local Chromium (set CHROMIUM_PATH if needed), no v0 credits.

**No public Vercel deployment is claimed by this repo's test report.** Native Node format researched; local client/SDK/Redis behavior verified. Import/deploy/smoke-test your own Vercel project.

Sources: [Vercel Node](https://vercel.com/docs/functions/runtimes/node-js), [env/redeploy](https://vercel.com/docs/environment-variables/managing-environment-variables), [limits](https://vercel.com/docs/functions/limitations), [Upstash REST](https://upstash.com/docs/redis/features/restapi), [v0 APIv2](https://v0.app/docs/api/v2).
