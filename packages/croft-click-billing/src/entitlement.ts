/**
 * Entitlements: what a DID may use on the official managed service.
 *
 * The authoritative source is state controlled by croft.click — never a
 * record in the user's own repository, since the user controls that. By
 * default this is the private BillingStore. Publishing a public
 * `click.croft.billing.entitlement` record from the service's own repository
 * is optional and off by default; see docs/croft-click/billing-design.md for
 * the privacy trade-off.
 */

import {
  getRecordFromPds,
  isAtprotoDid,
  resolvePds,
  type ResolveOptions,
} from "./did.js";
import type { BillingAccount, SubscriptionState } from "./store.js";
import type { StripeSubscription } from "./stripe.js";

export const ENTITLEMENT_COLLECTION = "click.croft.billing.entitlement";
/** The single paid tier. Add more only if real costs require it. */
export const PAID_TIER = "managed";

export interface AccessPolicy {
  /**
   * Extra time after the period end for an active subscription, so a renewal
   * webhook arriving late does not cut access off. Default 2 days.
   */
  renewalLeewaySeconds?: number;
  /** Access kept while Stripe retries a failed payment. Default 3 days. */
  pastDueGraceSeconds?: number;
}

const DAY = 24 * 60 * 60;

function periodBounds(sub: StripeSubscription): {
  start?: number;
  end?: number;
} {
  const items = sub.items?.data ?? [];
  const end =
    sub.current_period_end ??
    (items.length
      ? Math.max(...items.map((item) => item.current_period_end ?? 0)) ||
        undefined
      : undefined);
  const start =
    sub.current_period_start ??
    (items.length
      ? Math.min(...items.map((item) => item.current_period_start ?? Infinity))
      : undefined);
  return { start: Number.isFinite(start) ? start : undefined, end };
}

/**
 * Derive access from a subscription as Stripe currently reports it.
 *
 * - active / trialing: until the period end plus renewal leeway. A
 *   subscription set to cancel at period end stays active until then.
 * - past_due: a short grace window from the start of the unpaid period.
 * - everything else (canceled, unpaid, incomplete, incomplete_expired,
 *   paused): no access.
 */
export function deriveSubscriptionState(
  sub: StripeSubscription,
  observedAt: number,
  policy: AccessPolicy = {},
): SubscriptionState {
  const { start, end } = periodBounds(sub);
  let accessUntil: number | undefined;
  switch (sub.status) {
    case "active":
    case "trialing":
      if (end) accessUntil = end + (policy.renewalLeewaySeconds ?? 2 * DAY);
      break;
    case "past_due":
      if (start) accessUntil = start + (policy.pastDueGraceSeconds ?? 3 * DAY);
      break;
  }
  return {
    status: sub.status,
    accessUntil: accessUntil
      ? new Date(accessUntil * 1000).toISOString()
      : null,
    observedAt,
  };
}

export interface AccessDecision {
  entitled: boolean;
  tier: typeof PAID_TIER | null;
  /** When paid access lapses unless renewed; null when not entitled. */
  until: string | null;
  reason: "subscription" | "hold" | "no_subscription" | "expired";
}

/**
 * Decide access for a DID from private state. A missing account means the
 * free tier, never paid access. Callers must treat a store error as "not
 * entitled" (fail closed) and fall back to the free tier.
 */
export function decideAccess(
  account: BillingAccount | undefined,
  now: Date,
): AccessDecision {
  if (!account)
    return {
      entitled: false,
      tier: null,
      until: null,
      reason: "no_subscription",
    };
  if (account.hold)
    return { entitled: false, tier: null, until: null, reason: "hold" };
  const states = Object.values(account.subscriptions);
  if (!states.length) {
    return {
      entitled: false,
      tier: null,
      until: null,
      reason: "no_subscription",
    };
  }
  const best = states
    .map((state) => (state.accessUntil ? Date.parse(state.accessUntil) : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  if (best > now.getTime()) {
    return {
      entitled: true,
      tier: PAID_TIER,
      until: new Date(best).toISOString(),
      reason: "subscription",
    };
  }
  return { entitled: false, tier: null, until: null, reason: "expired" };
}

/** Public, non-sensitive entitlement record. No Stripe IDs, no email, no amounts. */
export interface EntitlementRecord {
  $type: typeof ENTITLEMENT_COLLECTION;
  subject: string;
  tier: string;
  validUntil: string;
  issuedAt: string;
}

export function buildEntitlementRecord(
  did: string,
  decision: AccessDecision,
  now: Date,
): EntitlementRecord | undefined {
  if (!decision.entitled || !decision.until || !decision.tier) return undefined;
  return {
    $type: ENTITLEMENT_COLLECTION,
    subject: did,
    tier: decision.tier,
    validUntil: decision.until,
    issuedAt: now.toISOString(),
  };
}

/**
 * Writes entitlement records to the croft.click service repository. The
 * record key is the subject DID (DIDs are valid record keys), so writes are
 * naturally idempotent upserts and a retried webhook can never create a
 * second, conflicting record.
 */
export interface EntitlementPublisher {
  put(record: EntitlementRecord): Promise<void>;
  remove(subjectDid: string): Promise<void>;
}

/**
 * Publisher backed by plain XRPC calls against the service account's PDS.
 * `getAccessToken` supplies a current access token for the service account
 * (for example from an app-password session); it is never logged here.
 */
export function createXrpcEntitlementPublisher(options: {
  pds: string;
  serviceDid: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
}): EntitlementPublisher {
  const fetcher = options.fetch ?? fetch;
  const call = async (method: string, body: Record<string, unknown>) => {
    const response = await fetcher(new URL(`/xrpc/${method}`, options.pds), {
      method: "POST",
      headers: {
        authorization: `Bearer ${await options.getAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${method} returned ${response.status}`);
  };
  return {
    put: (record) =>
      call("com.atproto.repo.putRecord", {
        repo: options.serviceDid,
        collection: ENTITLEMENT_COLLECTION,
        rkey: record.subject,
        record,
        validate: false,
      }),
    remove: (subjectDid) =>
      call("com.atproto.repo.deleteRecord", {
        repo: options.serviceDid,
        collection: ENTITLEMENT_COLLECTION,
        rkey: subjectDid,
      }),
  };
}

/** Pure validation of a fetched public entitlement record. */
export function validateEntitlementRecord(
  fetched: { uri: string; value: unknown },
  subjectDid: string,
  trustedServiceDid: string,
  now: Date,
): EntitlementRecord | undefined {
  // The authority in the URI must be the pinned service DID. A record using
  // the same lexicon in anyone else's repository is ignored.
  if (
    fetched.uri !==
    `at://${trustedServiceDid}/${ENTITLEMENT_COLLECTION}/${subjectDid}`
  ) {
    return undefined;
  }
  const value = fetched.value as Partial<EntitlementRecord> | null;
  if (!value || value.$type !== ENTITLEMENT_COLLECTION) return undefined;
  if (value.subject !== subjectDid || typeof value.tier !== "string")
    return undefined;
  const until =
    typeof value.validUntil === "string" ? Date.parse(value.validUntil) : NaN;
  if (!Number.isFinite(until) || until <= now.getTime()) return undefined;
  return value as EntitlementRecord;
}

/**
 * Independently verify a public entitlement by reading it from the trusted
 * service repository. Any failure — including a PDS outage — returns
 * undefined, so an outage can never grant access.
 */
export async function verifyPublicEntitlement(
  subjectDid: string,
  trustedServiceDid: string,
  options: ResolveOptions & { now?: () => Date } = {},
): Promise<EntitlementRecord | undefined> {
  if (!isAtprotoDid(subjectDid)) return undefined;
  try {
    const pds = await resolvePds(trustedServiceDid, options);
    const fetched = await getRecordFromPds(
      pds,
      trustedServiceDid,
      ENTITLEMENT_COLLECTION,
      subjectDid,
      options.fetch,
    );
    if (!fetched) return undefined;
    return validateEntitlementRecord(
      fetched,
      subjectDid,
      trustedServiceDid,
      (options.now ?? (() => new Date()))(),
    );
  } catch {
    return undefined;
  }
}
