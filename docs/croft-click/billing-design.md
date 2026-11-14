# croft.click managed service: identity, billing and entitlements

Status: **design + server library implemented, not yet deployed.** Nothing
here charges anyone until the maintainer completes the steps in
[Rollout](#rollout).

This is the design for issue #64. The code lives in
[`packages/croft-click-billing`](../../packages/croft-click-billing), and the
record schemas in [`packages/croft-click/lexicons`](../../packages/croft-click/lexicons).

## Principles this design keeps

- The software stays AGPL-3.0-only. Self-hosting needs no payment, no Stripe
  account and no croft.click service DID. `loadBillingConfig()` returns
  `undefined` when nothing is configured, and every tool keeps working.
- Payment buys use of the **official managed deployments**, not permission to
  run the code.
- There is **no croft.click account system**: no username, password, email or
  profile. A user's ATProto **DID** is their identity. Handles are display
  data only.
- Stripe is the billing provider, **not** the identity provider.
- No Stripe IDs, payment details or email addresses go into any ATProto record.
- One paid tier (`managed`) to start with.

## Components

| Piece         | Where                                               | What it does                                                                  |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Handshake     | `handshake.ts`, `click.croft.auth.handshake`        | Proves a browser controls a DID                                               |
| Sessions      | `session.ts`                                        | Short-lived signed web session for a proven DID                               |
| Stripe client | `stripe.ts`                                         | Checkout, Customer Portal, subscription reads, webhook signature checks       |
| Webhooks      | `webhook.ts`                                        | Maps Stripe lifecycle events to per-DID access, idempotently                  |
| Entitlements  | `entitlement.ts`, `click.croft.billing.entitlement` | Access decisions; optional public records from the service repo               |
| Private state | `store.ts`                                          | Challenges, DID ↔ Stripe customer link, processed event IDs, revoked sessions |
| Facade        | `service.ts`                                        | `CroftBilling`, the object route handlers call                                |

## Identity proof (the handshake)

The tools use ATProto OAuth **in the browser** (`@atproto/oauth-client-browser`).
That means the server never holds, or can verify, the OAuth session. The
handshake turns "this browser can write to DID X's repository" into
something the server can check independently.

```
Browser (OAuth session for DID)          croft.click server                 User's PDS
  │  POST /billing/handshake {did}  ──▶  issueChallenge(did)
  │  ◀── {collection, rkey, record}      stores {id, did, nonce, H(secret), expiry}
  │      + Set-Cookie: secret (HttpOnly)
  │  com.atproto.repo.createRecord  ─────────────────────────────────────────▶ write record
  │      (rkey, {service, nonce, createdAt, expiresAt})
  │  POST /billing/handshake/complete ─▶ completeHandshake(id, secret)
  │      (cookie carries secret)          resolve DID doc → PDS ─────────────▶ getRecord
  │                                       check uri, $type, service, nonce,
  │                                       createdAt window, expiresAt
  │                                       consume challenge (single use)
  │  ◀── Set-Cookie: __Host-croft_session
  │  com.atproto.repo.deleteRecord  ─────────────────────────────────────────▶ tidy up
```

What is checked, and why:

| Check                                                                                                                   | Defends against                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The DID is a `did:plc`/`did:web`, never a handle                                                                        | Handle reassignment                                                                                |
| The PDS comes from the DID document, resolved fresh, through an SSRF guard (HTTPS, default port, public addresses only) | Client-supplied record URIs; PDS migration; SSRF into the host network                             |
| The record URI is exactly `at://<did>/click.croft.auth.handshake/<rkey the server chose>`                               | Records from another repo or a reused record                                                       |
| `service` equals the pinned service DID                                                                                 | Proofs made for another service being replayed here                                                |
| `nonce` matches (constant-time)                                                                                         | Forged records                                                                                     |
| `createdAt` within the challenge window (±2 min skew), `expiresAt` not later than the challenge's                       | Old records being replayed                                                                         |
| Challenge consumed atomically on success or on an invalid record                                                        | Replay; double completion                                                                          |
| A separate **secret** held only by the requesting browser is required to complete                                       | Someone watching the firehose sees the public nonce and races the user to complete their challenge |

A missing record does **not** consume the challenge, so a slow PDS or relay
just means the client retries.

The server trusts the PDS that the DID document names, as every ATProto app
does. Future hardening, if wanted: fetch with `com.atproto.sync.getRecord`
and verify the commit signature against the DID's signing key, removing
trust in the PDS's HTTP responses.

Required OAuth scope for the tools that offer billing: add
`repo:click.croft.auth.handshake` (create and delete) to the existing scope
string and client metadata. No other new permission is needed.

## Sessions and devices

- A successful handshake mints a signed, stateless session token (HMAC-SHA256,
  24 h by default) carrying only `{sid, did, iat, exp}`, set as a
  `__Host-croft_session` cookie (`HttpOnly; Secure; SameSite=Lax`).
- **Another device**: sign in with ATProto there and do the handshake again.
  The entitlement is keyed by DID, so it follows automatically. No device
  cookie is needed to prove a subscription.
- **Logout** revokes that session ID only. It never touches billing. Other
  devices stay signed in until their sessions expire.
- **Cancelling** a subscription never ends a session. It only changes what
  the DID is entitled to.
- **Log everyone out**: rotate `CROFT_SESSION_SECRET` (prepend a new secret,
  then remove the old one).
- **Handle change**: nothing happens. Nothing is keyed by handle.
- **PDS migration**: nothing happens. The PDS is resolved from the DID
  document each time, and entitlements are keyed by DID.
- **DID becomes unresolvable or tombstoned**: new handshakes fail, so no new
  sessions. Existing sessions run out within their TTL. Billing continues as
  normal until the user or maintainer cancels in Stripe.

## Billing model

**Recommendation: one monthly recurring subscription** through Stripe
Checkout (`mode=subscription`), managed through the Stripe Customer Portal.

- It matches the actual cost (ongoing hosting), it is the model the issue
  leans toward, and the Customer Portal gives self-service cancellation and
  card updates with no UI to build.
- One-off "passes" would need expiry and top-up UX and give no clean
  cancellation story. They can be added later as another Checkout mode if
  wanted.
- Annual billing can be added later as a second **price** on the same
  product without changing any code beyond `STRIPE_PRICE_ID` selection.

Checkout binds the DID through **server-set** metadata
(`client_reference_id`, `metadata.did`, `subscription_data.metadata.did`).
Only the server's secret key can set these, so they are trustworthy in
webhooks. No email is sent to Stripe by croft.click; Stripe Checkout
collects what it needs for receipts. A DID that is already entitled is sent
to the Customer Portal instead of a new Checkout, so nobody pays twice by
mistake.

### Webhooks

Endpoint: `POST /api/billing/webhook` (raw body), events:

`checkout.session.completed`, `customer.subscription.created|updated|deleted|paused|resumed`,
`invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`.

- **Signatures** are verified against the raw body with a 5-minute
  tolerance. Several secrets can be configured for rotation.
- **Mode**: events whose `livemode` differs from `CROFT_BILLING_MODE` are
  ignored, so test events can never grant live access.
- **Idempotency and ordering**: for every subscription-related event the
  handler **re-reads the subscription from the Stripe API** and replaces that
  subscription's stored state. Duplicate deliveries give the same result, and
  a late, stale event cannot roll a cancellation back. Event IDs are recorded
  only after successful processing, so a failure is retried by Stripe.
- **One customer, one DID**: an event linking a Stripe customer to a
  different DID than it already serves is ignored.

### Access rules

| Stripe state                                                       | Access                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `active`, `trialing`                                               | Until period end + 2 days' renewal leeway (late renewal webhooks don't cut anyone off)                |
| `active` with cancel at period end                                 | Same, then ends                                                                                       |
| `past_due`                                                         | 3 days' grace from the start of the unpaid period while Stripe retries                                |
| `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, `paused` | None                                                                                                  |
| Full refund or dispute (chargeback)                                | **Hold**: no access until the maintainer clears it with `clearHold()`. Partial refunds change nothing |

If a DID somehow has two subscriptions, access is the best of them, so
cancelling one does not cut off the other.

## Authoritative entitlement: private by default

The user's own repository can never be evidence of payment, since the user
controls it. The issue prefers a public record from a croft.click service
account and asks for the privacy implications before choosing. They are:

- ATProto repositories are public, and records are broadcast on the firehose
  and copied by relays, AppViews and archivers. **Deleting a record later
  does not remove copies already made.**
- A public entitlement record therefore publishes, effectively permanently,
  that a given DID (and, through it, its handle and profile) **pays
  croft.click**, and roughly when. That is financial-relationship data about
  a named person.
- Under UK GDPR that is personal data the service would be publishing as
  data controller. Publishing it would need a clear lawful basis (most
  likely explicit, freely given, opt-in consent) and could not be undone.
- What publishing buys: third parties (or self-hosted forks) can verify an
  entitlement without asking croft.click. Nothing in the current tool suite
  needs that. The tools are all run by the same operator who holds the
  private state.

**Decision implemented:** DID stays the identity; the authoritative
entitlement is the **minimal private mapping** in `BillingStore`
(DID → Stripe customer reference + per-subscription status/expiry, plus an
optional hold). Public records are fully implemented but **off** unless
`CROFT_PUBLISH_ENTITLEMENTS=true`. If the maintainer later wants them (for
example an opt-in "supporter" badge), they work as follows:

- Written only by the service account, with **rkey = subject DID**, so each
  write is an idempotent upsert and webhook retries can never create
  conflicting records.
- Fields: `subject`, `tier`, `validUntil`, `issuedAt`. Nothing else.
- Revocation: the record is deleted when access ends, and `validUntil` makes
  it lapse on its own if a deletion is ever missed.
- Verification (`verifyPublicEntitlement`) reads only from the **pinned
  service DID's** repository, resolved via its DID document. A record with
  the same lexicon anywhere else is ignored. Any failure (PDS outage,
  resolution error) returns "not entitled".

Before turning this on, per-user opt-in should be added so that only DIDs
that asked are published.

## Trust root and key rotation

`CROFT_SERVICE_DID` is part of the trust root. It is used to bind handshake
records (`service` field) and, if public entitlements are on, as the only
repository entitlements are read from.

- **Use a `did:plc`** for the service account, with a recovery (rotation)
  key that the maintainer holds offline, separate from the PDS's signing key.
  This allows recovery if the PDS or its credentials are lost.
- **Signing key / PDS change**: the DID stays the same, so nothing in
  croft.click changes; verifiers resolve the new PDS from the DID document.
- **Replacing the service DID** (should never be needed with a recovery
  key): set the new DID, accept both during a transition (handshakes are
  short-lived so only the deploy window matters), and if public entitlements
  are on, republish them from the new repository before removing the old
  ones. The private store is unaffected.
- **Session secret leak**: rotate `CROFT_SESSION_SECRET`, which logs
  everyone out.
- **Stripe webhook secret leak**: roll the endpoint secret in Stripe, add
  the new one to `STRIPE_WEBHOOK_SECRET`, then remove the old one.
- **Stripe API key leak**: roll the key in the Stripe Dashboard. Use a
  **restricted key** (`rk_…`) limited to Checkout Sessions (write), Customer
  Portal (write), Subscriptions (read) and Charges (read).

## Outages and degraded operation

- **Store unavailable**: `getAccess()` fails closed, meaning the free tier.
  The tools still work within free limits.
- **Stripe unavailable**: existing entitlements keep working (they are
  stored with explicit expiry and need no Stripe call to check). Checkout and
  Portal fail with a clear message. Webhooks are retried by Stripe for up to
  three days.
- **User's PDS unavailable**: new handshakes fail. Existing sessions keep
  working. This never grants access.
- **Service PDS unavailable** (public mode only): verification returns "not
  entitled". Nothing is granted on error.
- Rate and abuse limits apply to everyone regardless of payment status.

## Data kept, and removal

| Data                                                       | Where                | Kept for                                                                         |
| ---------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| Challenge (DID, nonce, hash of secret)                     | Private store        | Until used or 10 minutes                                                         |
| Revoked session IDs                                        | Private store        | Until the session would have expired                                             |
| DID ↔ Stripe customer ID, subscription status/expiry, hold | Private store        | While billing is active, plus what UK accounting rules require (to be confirmed) |
| Processed webhook event IDs                                | Private store        | 30+ days is enough for de-duplication                                            |
| Handshake record                                           | User's own repo      | Deleted by the client after success. The user can delete it any time             |
| Entitlement record (only if enabled)                       | Service repo, public | Deleted when access ends                                                         |
| Card details, email, billing address                       | Stripe only          | Stripe's policy                                                                  |

**Removal request**: cancel any subscription in Stripe, call
`store.deleteAccount(did)`, delete any public entitlement record, revoke
sessions (or let them expire). Deleting the Stripe customer itself is
subject to accounting retention, to be confirmed.

## Rollout

1. ✅ Maintenance policy and per-tool status: [`MAINTENANCE.md`](../../MAINTENANCE.md)
2. ⬜ Measure actual hosting/runtime costs ([hosting.md](./hosting.md))
3. ⬜ Choose hosting and a persistent store with atomic operations
4. ✅ Handshake and entitlement lexicons + threat model (this document)
5. ✅ Shared handshake verification, sessions (`@ewanc26/croft-click-billing`)
6. ✅ Stripe test-mode integration bound to DIDs (library + tests)
7. ✅ Entitlement path: private mapping, optional public records
8. ⬜ Wire routes and billing UI into the deployment (see the package README for the route shapes); add the handshake scope to OAuth client metadata
9. ⬜ Publish pricing, limits, cancellation/refund terms, privacy notice; give users notice
10. ⬜ Migrate or upgrade hosting if needed
11. ⬜ Confirm UK requirements (see below), then switch to live mode
12. ⬜ Review costs, support load and conversion after real use

## Still the maintainer's decisions

- The price, the free-tier limits per tool, and which tools have a paid tier.
- Whether to ever publish public entitlement records.
- The hosting platform and store.
- **UK business/compliance**: tax and accounting, consumer terms (including
  the 14-day cancellation right for digital services and how it is waived
  or honoured), privacy/data-controller obligations, and whether and when VAT
  registration or collection applies. Check current HMRC and ICO guidance
  before live payments. This design deliberately encodes no assumptions
  about thresholds. Stripe Tax can calculate VAT if registration applies.
