# croft.click hosting evaluation

Status: **framework, not a decision.** Prices change and need to be read
from each provider's current pricing page and the maintainer's real usage
dashboards, so no figures are filled in here. Fill in the table, then pick.
Moving platforms just for the sake of it is not a goal: if Vercel Pro is
cheaper and simpler overall, staying on Vercel is a valid outcome.

## Why anything has to change

The official deployments are on Vercel Hobby, whose terms limit it to
personal, non-commercial use. A paid managed service is commercial use, so
before live payments are switched on the deployments that take payments,
and arguably every deployment that a paid plan unlocks, must be on a plan or
platform that permits commercial use.

## What the managed service needs

From [`billing-design.md`](./billing-design.md) and the existing apps:

- **Static/SSR SvelteKit apps** for each tool and croft.click itself.
  They currently use `@sveltejs/adapter-vercel`.
- **Server endpoints**: the existing `/api/toolkit-usage` aggregator, plus
  four billing routes (handshake begin/complete, checkout/portal redirect,
  Stripe webhook). The webhook needs the **raw request body** and a stable
  public HTTPS URL.
- **A small persistent store with atomic operations** for challenges
  (single-use delete), per-DID billing state (read-modify-write), processed
  webhook IDs and revoked sessions. This is tiny: a few hundred bytes per
  paying DID. Serverless functions have no local persistence, so on Vercel
  this is an external KV/SQL service. On a VM it can be SQLite.
- **Shared sessions across subdomains** only if paid capabilities live on
  the tool subdomains. A `__Host-` cookie is per-host, so either do billing
  and paid features on the same host, or use a short-lived token handed to
  each tool after the handshake. Decide alongside hosting.
- Imported user datasets stay in the browser and the user's PDS. **Nothing**
  here requires central storage of user content.

## Comparison

For each option, record the current figures:

| Criterion                                                                                 | Vercel Pro | Option B | Option C |
| ----------------------------------------------------------------------------------------- | ---------- | -------- | -------- |
| Commercial use allowed                                                                    |            |          |          |
| Monthly baseline cost                                                                     |            |          |          |
| Bandwidth/egress pricing and included amount                                              |            |          |          |
| Function limits (duration, memory, body size), relevant to Malachite/Jasper server routes |            |          |          |
| Stripe webhook endpoint (raw body, stable URL)                                            |            |          |          |
| Persistent store for billing state (product, cost, atomic ops)                            |            |          |          |
| Deploys from this pnpm monorepo                                                           |            |          |          |
| Preview deployments                                                                       |            |          |          |
| Custom domains and `*.croft.click` subdomains                                             |            |          |          |
| Logs and observability                                                                    |            |          |          |
| Backup and restore of the billing store                                                   |            |          |          |
| **Expected monthly cost at current usage**                                                |            |          |          |
| **Expected monthly cost at a reasonable growth case (e.g. 5× traffic)**                   |            |          |          |
| Migration effort                                                                          | none       |          |          |

Candidates worth a row: Vercel Pro (no migration; needs an external store);
Cloudflare Pages/Workers (adapter swap; has KV and D1); Netlify; a small VPS
or container host running the Node adapter with SQLite (predictable cost,
but the maintainer then runs backups, TLS and patching).

## Inputs to gather first

- The last 3 months of Vercel usage per project: bandwidth, function
  invocations, function duration and build minutes.
- Which tools actually run server code on each request, and which are
  effectively static.
- Expected number of paying users in the first year. This sets how much
  fixed cost the price must cover.

## Decision rule

Choose the option with the lowest **total** monthly cost (platform + store +
the maintainer's time to run it) that meets every row. Prefer no migration
when costs are close. Record the choice and figures here.

## Backups

Whatever the store, the billing state can be **rebuilt from Stripe**: every
subscription carries `metadata.did`, so listing subscriptions and replaying
`deriveSubscriptionState` restores the DID → access mapping. Holds
(refund/dispute) are the only state not derivable and should be noted in
the Stripe Dashboard as well. A daily export of the store is still
recommended.
