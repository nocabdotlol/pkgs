# @ewanc26/croft-click-billing

Server-side pieces for the **official croft.click managed service**:
DID-control handshake, short-lived sessions, Stripe Checkout/Customer
Portal, verified and idempotent webhooks, and DID-keyed entitlements.

There is no account system. A user's ATProto DID is their identity, and
Stripe is used only for billing. The design, threat model and privacy
decisions are in
[`docs/croft-click/billing-design.md`](../../docs/croft-click/billing-design.md).

**Self-hosting does not need any of this.** With none of the variables
below set, `loadBillingConfig()` returns `undefined` and the tools run
exactly as before.

No runtime dependencies: Stripe is called over its REST API with `fetch`,
and signatures use `node:crypto`. Requires Node 22+.

## Environment variables

Never commit these. `.env*` files are already git-ignored.

| Variable                     | Required | Example               | Notes                                                                                                                         |
| ---------------------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CROFT_BILLING_MODE`         | yes      | `test`                | `test` or `live`. The key prefix must match, and test events are ignored in live mode and vice versa                          |
| `STRIPE_SECRET_KEY`          | yes      | `rk_test_…`           | Prefer a **restricted key**: Checkout Sessions write, Customer Portal write, Subscriptions read, Charges read                 |
| `STRIPE_WEBHOOK_SECRET`      | yes      | `whsec_…`             | Comma-separate several during rotation                                                                                        |
| `STRIPE_PRICE_ID`            | yes      | `price_…`             | The recurring price for the single paid tier                                                                                  |
| `CROFT_SERVICE_DID`          | yes      | `did:plc:…`           | DID of the maintainer-controlled croft.click account. Part of the trust root                                                  |
| `CROFT_SESSION_SECRET`       | yes      | 32+ random chars      | Comma-separate for rotation. The first entry signs new sessions                                                               |
| `CROFT_PUBLIC_ORIGIN`        | yes      | `https://croft.click` | HTTPS; `http://127.0.0.1:…` is allowed in test mode                                                                           |
| `CROFT_PUBLISH_ENTITLEMENTS` | no       | `false`               | Publish public entitlement records from the service account. Off by default; read the privacy section of the design doc first |

Generate a session secret with `openssl rand -base64 48`.

## Stripe setup (in the Dashboard, not in this repo)

Do all of this in **test mode** first.

1. **Product**: create one product, e.g. "croft.click managed", with one
   **recurring monthly price**. Put its ID in `STRIPE_PRICE_ID`.
2. **Customer Portal**: Settings → Billing → Customer portal. Enable
   cancellation (at end of period), payment method updates and invoice
   history. Set the terms and privacy links once they're published.
3. **Webhook endpoint**: `https://<origin>/api/billing/webhook`, subscribed to:
   - `checkout.session.completed`
   - `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`
   - `invoice.paid`, `invoice.payment_failed`
   - `charge.refunded`, `charge.dispute.created`

   Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

4. **API key**: create a restricted key with the permissions above.

For local development, the Stripe CLI forwards test events and prints a
temporary `whsec_` secret:

```bash
stripe listen --forward-to http://127.0.0.1:5173/api/billing/webhook
```

Use Stripe's published test cards (for example `4242 4242 4242 4242`) in
Checkout. Nothing in test mode can charge a real card.

## Using it from SvelteKit

`CroftBilling` is framework-agnostic. Route handlers only move cookies and
bodies around. A sketch:

```ts
// src/lib/server/billing.ts
import { env } from "$env/dynamic/private";
import { CroftBilling, loadBillingConfig } from "@ewanc26/croft-click-billing";
import { store } from "./billing-store"; // a persistent store, see below

const config = loadBillingConfig(env);
export const billing = config ? new CroftBilling({ config, store }) : undefined;
```

| Route                                  | Does                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/billing/handshake` `{did}`  | `billing.beginHandshake(did)`. Return `{collection, rkey, record}`; put `secret` and `rkey` in an `HttpOnly; Secure; SameSite=Strict` cookie                                       |
| _(browser)_                            | `createRecord` with that `rkey` and `{...record, createdAt: now}` using its OAuth session                                                                                          |
| `POST /api/billing/handshake/complete` | `billing.completeHandshake(rkey, secret)` from the cookie. Set `sessionCookie(token, session)`. Browser then deletes the handshake record                                          |
| `POST /api/billing/checkout`           | `getSession(cookie)`, then redirect to `billing.checkoutUrl(session)`                                                                                                              |
| `POST /api/billing/portal`             | redirect to `billing.portalUrl(session)`                                                                                                                                           |
| `POST /api/billing/logout`             | `billing.logout(session)`, then `clearSessionCookie()`                                                                                                                             |
| `POST /api/billing/webhook`            | `billing.handleWebhook(await request.text(), request.headers.get('stripe-signature'))`. Return 400 on `WebhookSignatureError`, 500 on other errors (Stripe retries), 200 otherwise |

Return `404` from every billing route when `billing` is `undefined`, so
self-hosted copies simply have no billing.

Paid features check `await billing.getAccess(session.did)` on the
**server**. Never trust a client-side flag.

Add `repo:click.croft.auth.handshake` to the OAuth `scope` of any tool that
offers sign-in for the managed service, in both the code and its
`client-metadata.json`.

## Persistent store

`MemoryStore` is for tests and local development only. Production needs a
store implementing `ChallengeStore & BillingStore & SessionRevocationStore`
where `consumeChallenge` is an atomic delete and `updateAccount` is an
atomic read-modify-write per DID (a transaction, or compare-and-set). Which
database depends on the hosting decision in
[`docs/croft-click/hosting.md`](../../docs/croft-click/hosting.md).

## Tests

```bash
pnpm --filter @ewanc26/croft-click-billing test
```

Every network call is mocked. The tests never contact Stripe, PLC or any
PDS.

## Licence

AGPL-3.0-only
