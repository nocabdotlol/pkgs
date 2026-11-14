/**
 * Stripe webhook processing.
 *
 * Idempotency and ordering: rather than trusting the payload of each event
 * (Stripe may deliver events late, twice, or out of order), every
 * subscription-related event triggers a fresh read of the subscription from
 * the Stripe API, and the result replaces that subscription's stored state.
 * Applying the same event twice therefore yields the same state, and a late
 * old event cannot roll state back. Processed event IDs are recorded only
 * after success so a failed attempt is retried by Stripe.
 */

import {
  buildEntitlementRecord,
  decideAccess,
  deriveSubscriptionState,
  type AccessPolicy,
  type EntitlementPublisher,
} from "./entitlement.js";
import { isAtprotoDid } from "./did.js";
import type { AccessHold, BillingAccount, BillingStore } from "./store.js";
import type {
  StripeClient,
  StripeEvent,
  StripeSubscription,
} from "./stripe.js";

export interface WebhookDeps {
  store: BillingStore;
  stripe: Pick<StripeClient, "retrieveSubscription" | "retrieveCharge">;
  /** Only set when public entitlement records are enabled. */
  publisher?: EntitlementPublisher;
  policy?: AccessPolicy;
  /** Expected livemode. Events from the other mode are rejected. */
  livemode: boolean;
  now?: () => Date;
}

export type WebhookOutcome =
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | { status: "applied"; did: string; entitled: boolean };

function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }
  return undefined;
}

/** Invoices moved their subscription reference in newer API versions. */
function invoiceSubscriptionId(
  invoice: Record<string, unknown>,
): string | undefined {
  const direct = idOf(invoice.subscription);
  if (direct) return direct;
  const parent = invoice.parent as
    | { subscription_details?: { subscription?: unknown } }
    | undefined;
  return idOf(parent?.subscription_details?.subscription);
}

function emptyAccount(did: string, now: Date): BillingAccount {
  return { did, subscriptions: {}, updatedAt: now.toISOString() };
}

async function publish(
  deps: Pick<WebhookDeps, "publisher">,
  account: BillingAccount,
  now: Date,
): Promise<boolean> {
  const decision = decideAccess(account, now);
  if (deps.publisher) {
    const record = buildEntitlementRecord(account.did, decision, now);
    if (record) await deps.publisher.put(record);
    else await deps.publisher.remove(account.did);
  }
  return decision.entitled;
}

async function syncSubscription(
  subscriptionId: string,
  deps: WebhookDeps,
  now: Date,
  linkedDid?: string,
): Promise<WebhookOutcome> {
  const sub: StripeSubscription =
    await deps.stripe.retrieveSubscription(subscriptionId);
  const did = sub.metadata?.did;
  if (!isAtprotoDid(did)) {
    return { status: "ignored", reason: "subscription has no DID metadata" };
  }
  if (linkedDid && linkedDid !== did) {
    return {
      status: "ignored",
      reason: "checkout and subscription DIDs disagree",
    };
  }
  const customerId = idOf(sub.customer);
  const owner = customerId
    ? await deps.store.findDidByCustomer(customerId)
    : undefined;
  if (owner && owner !== did) {
    // One Stripe customer must never serve two DIDs.
    return {
      status: "ignored",
      reason: "customer is linked to a different DID",
    };
  }
  const state = deriveSubscriptionState(
    sub,
    Math.floor(now.getTime() / 1000),
    deps.policy,
  );
  const account = await deps.store.updateAccount(did, (current) => {
    const next = current ?? emptyAccount(did, now);
    if (!next.stripeCustomerId && customerId)
      next.stripeCustomerId = customerId;
    next.subscriptions[sub.id] = state;
    next.updatedAt = now.toISOString();
    return next;
  });
  return {
    status: "applied",
    did,
    entitled: await publish(deps, account, now),
  };
}

async function placeHold(
  customerId: string | undefined,
  reason: AccessHold,
  deps: WebhookDeps,
  now: Date,
): Promise<WebhookOutcome> {
  const did = customerId
    ? await deps.store.findDidByCustomer(customerId)
    : undefined;
  if (!did)
    return { status: "ignored", reason: "charge is not linked to a known DID" };
  const account = await deps.store.updateAccount(did, (current) => {
    const next = current ?? emptyAccount(did, now);
    next.hold ??= { reason, since: now.toISOString() };
    next.updatedAt = now.toISOString();
    return next;
  });
  return {
    status: "applied",
    did,
    entitled: await publish(deps, account, now),
  };
}

export async function handleStripeEvent(
  event: StripeEvent,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  if (event.livemode !== deps.livemode) {
    return { status: "ignored", reason: "event is from the other Stripe mode" };
  }
  if (await deps.store.hasProcessedEvent(event.id))
    return { status: "duplicate" };
  const now = (deps.now ?? (() => new Date()))();
  const object = event.data.object;
  let outcome: WebhookOutcome;

  switch (event.type) {
    case "checkout.session.completed": {
      if (object.mode !== "subscription") {
        outcome = { status: "ignored", reason: "not a subscription checkout" };
        break;
      }
      const metadata = object.metadata as Record<string, string> | undefined;
      const did = metadata?.did;
      const subscriptionId = idOf(object.subscription);
      if (
        !isAtprotoDid(did) ||
        object.client_reference_id !== did ||
        !subscriptionId
      ) {
        outcome = {
          status: "ignored",
          reason: "checkout session is missing its DID binding",
        };
        break;
      }
      outcome = await syncSubscription(subscriptionId, deps, now, did);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const subscriptionId = idOf(object.id);
      outcome = subscriptionId
        ? await syncSubscription(subscriptionId, deps, now)
        : { status: "ignored", reason: "no subscription id" };
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const subscriptionId = invoiceSubscriptionId(object);
      outcome = subscriptionId
        ? await syncSubscription(subscriptionId, deps, now)
        : { status: "ignored", reason: "invoice is not for a subscription" };
      break;
    }
    case "charge.refunded": {
      const fullyRefunded =
        typeof object.amount === "number" &&
        object.amount_refunded === object.amount;
      outcome = fullyRefunded
        ? await placeHold(idOf(object.customer), "refund", deps, now)
        : {
            status: "ignored",
            reason: "partial refund does not change access",
          };
      break;
    }
    case "charge.dispute.created": {
      // A dispute references its charge, not the customer, so read the charge.
      const charge = object.charge;
      const customerId =
        typeof charge === "object" && charge
          ? idOf((charge as { customer?: unknown }).customer)
          : typeof charge === "string"
            ? idOf((await deps.stripe.retrieveCharge(charge)).customer)
            : undefined;
      outcome = await placeHold(customerId, "dispute", deps, now);
      break;
    }
    default:
      outcome = {
        status: "ignored",
        reason: `unhandled event type ${event.type}`,
      };
  }

  await deps.store.markEventProcessed(event.id);
  return outcome;
}

/** Lift a refund/dispute hold after manual review. */
export async function clearHold(
  did: string,
  deps: Pick<WebhookDeps, "store" | "publisher" | "now">,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const account = await deps.store.updateAccount(did, (current) => {
    const next = current ?? emptyAccount(did, now);
    delete next.hold;
    next.updatedAt = now.toISOString();
    return next;
  });
  await publish(deps, account, now);
}
