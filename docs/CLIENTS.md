# Codex / Claude Code

Install the coding CLI yourself. Tested client versions are recorded in TESTING.md; other versions may change protocol/features.

Use the optional cross-platform Node launcher (interactive, normal permission prompts):

```bash
# Bash
export BRIDGE_BASE_URL=https://YOUR_DOMAIN
export GATEWAY_CLIENT_KEY=YOUR_GATEWAY_KEY
node scripts/client.mjs codex --project /path/to/project --session work-1
# Later, SAME project/session:
node scripts/client.mjs codex --project /path/to/project --session work-1 --resume

node scripts/client.mjs claude --project /path/to/project --session work-2
node scripts/client.mjs claude --project /path/to/project --session work-2 --resume
```

PowerShell:

```powershell
$env:BRIDGE_BASE_URL='https://YOUR_DOMAIN'
$env:GATEWAY_CLIENT_KEY='YOUR_GATEWAY_KEY'
node scripts/client.mjs codex --project 'C:\work\project' --session work-1
```

Client settings/history are isolated under `~/.v0-bridge-clients/<client>/<session>`, not your primary CLI profile. Choose a NEW session for new conversations; use `--resume` for an existing one. Do not `/clear`/fork/rewind while keeping an old header. Use same model/protocol/project on resume. Claude --continue uses latest saved conversation for that directory/home.

Astra is default for Codex; Fable for Claude. Basic local coding tools only. The launcher disables tool search and optional experimental traffic, and requests compatibility settings. Some model IDs still make Claude Code send a thinking config; the bridge accepts that as transport metadata without forwarding a native budget or returning signed thinking blocks. Other advanced client features may not work; full protocol parity is not promised.

Launcher does not pass v0/Redis credentials to the child CLI. Still use a client-only terminal environment whenever possible. Windows launchers were reviewed but not executed on Windows. Linux actual live CLI tests used dedicated projects; Codex sandbox was disabled there only because the test host lacks bwrap. The supplied user launcher retains workspace-write sandbox and on-request approval.

## Manual Codex provider

```toml
model_provider = "v0bridge"
model = "openai/gpt-6-astra"
model_reasoning_effort = "high"
[model_providers.v0bridge]
name = "v0 bridge"
base_url = "https://YOUR_DOMAIN/v1"
env_key = "V0_BRIDGE_KEY"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
http_headers = { "X-V0-Session" = "unique-conversation-id" }
```

Set `V0_BRIDGE_KEY` to the gateway key, never v0 key. Native effort is NOT established; high here is only a hint.

## Manual Claude

Set ANTHROPIC_BASE_URL to domain (no /v1), ANTHROPIC_AUTH_TOKEN to gateway key, ANTHROPIC_CUSTOM_HEADERS to `X-V0-Session: unique-conversation-id`. Model `anthropic/claude-fable-5.1`. Follow the launcher compatibility flags to avoid unsupported native thinking/tool search. Never disable permissions globally just to make a client run.

**Thinking request compatibility:** Claude Code may insist on a thinking/adaptive config for some model IDs even with compatibility flags. The adapter accepts recognized thinking configs for transport compatibility, but does not forward a native thinking budget or return signed native thinking blocks. Header `X-V0-Thinking-Control` discloses this. Do not interpret successful requests as native thinking-control support.

If you change the env model allowlist, pass an actual listed ID: `node scripts/client.mjs codex --project PATH --session NEW --model openai/your-model`. Keep model/protocol unchanged on resume.
