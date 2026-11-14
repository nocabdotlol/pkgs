# AGENTS.md

## Purpose

`@ewanc26/croft-click-billing` holds the server-side identity, session,
Stripe and entitlement code for the official croft.click managed service.
Design and threat model: `docs/croft-click/billing-design.md`.

## Rules

- The DID is the only identity. Never key anything by handle, and never add
  usernames, passwords, emails or profiles.
- Never put Stripe IDs, amounts, emails or payment details into any ATProto
  record. Public entitlement records carry only `subject`, `tier`,
  `validUntil` and `issuedAt`.
- Keep this package free of runtime dependencies unless there is a strong
  reason; Stripe is called over REST.
- Resolve PDS endpoints from DID documents through `assertPublicHttpsOrigin`.
  Never fetch a client-supplied record URI.
- Fail closed: any error while deciding access means the free tier.
- Webhook handling must stay idempotent: re-read subscriptions from Stripe
  rather than trusting event payload order.
- Keep `click.croft.auth.handshake` and `click.croft.billing.entitlement`
  in `packages/croft-click/lexicons` in sync with the TypeScript types.
- Tests must mock every network call. Never use real Stripe credentials.

<!-- allowed-agents -->

## Allowed agents

Only **Claude** (Anthropic) and **Mistral** (Mistral AI) may be used as coding agents in this repository. This rule supersedes any earlier agent-attribution guidance in this file.

- Agent-assisted commits must credit only one of those agents:
  - `Co-Authored-By: Claude <noreply@anthropic.com>`
  - `Co-Authored-By: Mistral Vibe <vibe@mistral.ai>`
- Allowed agent footers are `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and `🤖 Generated with [Mistral Vibe](https://mistral.ai)`.
- Do not add `Co-Authored-By:` trailers, `Generated with` footers, author names, or committer identities for any other agent or AI tool.
- Do not credit another agent in commit metadata.
