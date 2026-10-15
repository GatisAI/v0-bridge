# Security notes

This is an experimental personal/shared-key bridge, not a production reseller control plane.

- Never commit `.env`, upstream keys, Redis tokens, CLI homes, or live histories. Keep secrets server-side, never NEXT_PUBLIC_ or public frontend bundles.
- Give callers only a random gateway key. Anyone holding a shared key can spend your v0 credits; soft counters are not a hard account spending limit.
- Use separate stable key IDs and unguessable session IDs when callers must not share conversation scope. There are no user accounts/customer quotas or privileged admin dashboard. PIN only gates generation of INACTIVE random candidate keys, never activation or secret access.
- Protect Redis; it stores client histories and tool outputs. Enable provider controls/backups/appropriate retention if you need them. Do not share the database across untrusted forks.
- API-key removal/rotation takes effect only in deployments receiving the new env. Restrict/delete historical deployments and account for in-flight work. Rotate upstream credentials if leaked.
- Keep coding-client permissions/sandbox enabled on real machines; generated tool calls may be wrong or unsafe. The server validates structural schema, not command safety or business semantics. JSON Schema formats are treated as annotations; arbitrary schema dialect/remote references are not guaranteed.
- Native v0 side effects are discouraged and detected after generation where recognizable parts exist; no complete upstream sandbox guarantee.
- Review timeout failures in v0 before retrying. A client/server disconnect does not necessarily cancel paid upstream work.
- First-run landing/ENV Generator has no server-secret hydration. Without ADMIN_PIN, candidate generation is intentionally open; with it, PIN is checked server-side. Per-instance throttling is best effort, not a distributed security boundary. Exported files/clipboard contain secrets and must remain private.
- No full security audit or unlimited-load test has been performed. Keep dependencies current. Do not publish a real key in issues or logs.
