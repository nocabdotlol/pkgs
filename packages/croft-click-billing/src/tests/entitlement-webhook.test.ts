import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideAccess,
  deriveSubscriptionState,
  ENTITLEMENT_COLLECTION,
  validateEntitlementRecord,
  verifyPublicEntitlement,
  type EntitlementPublisher,
  type EntitlementRecord,
} from "../entitlement.js";
import { MemoryStore } from "../store.js";
import type { StripeEvent, StripeSubscription } from "../stripe.js";
import { clearHold, handleStripeEvent, type WebhookDeps } from "../webhook.js";
import {
  json,
  mockFetch,
  OTHER_DID,
  plc,
  publicLookup,
  SERVICE_DID,
  SERVICE_PDS,
  USER_DID,
} from "./helpers.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;

function sub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: "sub_1",
    object: "subscription",
    status: "active",
    customer: "cus_1",
    metadata: { did: USER_DID },
    items: {
      data: [
        {
          current_period_start: nowS - 10 * DAY,
          current_period_end: nowS + 20 * DAY,
        },
      ],
    },
    ...overrides,
  };
}

let eventCounter = 0;
function event(
  type: string,
  object: Record<string, unknown>,
  livemode = false,
): StripeEvent {
  return {
    id: `evt_${++eventCounter}`,
    type,
    created: nowS,
    livemode,
    data: { object },
  };
}

function harness(subscriptions: Record<string, StripeSubscription>) {
  const store = new MemoryStore();
  const published = new Map<string, EntitlementRecord>();
  const publisher: EntitlementPublisher = {
    put: async (record) => void published.set(record.subject, record),
    remove: async (did) => void published.delete(did),
  };
  let retrievals = 0;
  const deps: WebhookDeps = {
    store,
    publisher,
    livemode: false,
    now: () => NOW,
    stripe: {
      retrieveSubscription: async (id) => {
        retrievals++;
        const found = subscriptions[id];
        if (!found) throw new Error("no such subscription");
        return structuredClone(found);
      },
      retrieveCharge: async (id) => ({ id, customer: "cus_1" }),
    },
  };
  return {
    store,
    published,
    deps,
    subscriptions,
    retrievals: () => retrievals,
  };
}

const checkoutCompleted = (did = USER_DID) =>
  event("checkout.session.completed", {
    mode: "subscription",
    client_reference_id: did,
    metadata: { did },
    subscription: "sub_1",
    customer: "cus_1",
  });

describe("subscription → access", () => {
  it("grants active and trialing subscriptions until period end plus leeway", () => {
    for (const status of ["active", "trialing"]) {
      const state = deriveSubscriptionState(sub({ status }), nowS);
      assert.equal(
        state.accessUntil,
        new Date((nowS + 22 * DAY) * 1000).toISOString(),
      );
    }
  });

  it("reads the legacy subscription-level period too", () => {
    const state = deriveSubscriptionState(
      sub({ items: undefined, current_period_end: nowS + DAY }),
      nowS,
      { renewalLeewaySeconds: 0 },
    );
    assert.equal(
      state.accessUntil,
      new Date((nowS + DAY) * 1000).toISOString(),
    );
  });

  it("gives past_due a short grace window from the unpaid period start", () => {
    const state = deriveSubscriptionState(
      sub({
        status: "past_due",
        items: {
          data: [
            {
              current_period_start: nowS - DAY,
              current_period_end: nowS + 29 * DAY,
            },
          ],
        },
      }),
      nowS,
    );
    assert.equal(
      state.accessUntil,
      new Date((nowS + 2 * DAY) * 1000).toISOString(),
    );
  });

  it("grants nothing for ended or incomplete subscriptions", () => {
    for (const status of [
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ]) {
      assert.equal(
        deriveSubscriptionState(sub({ status }), nowS).accessUntil,
        null,
        status,
      );
    }
  });

  it("treats a missing account as the free tier and honours holds", () => {
    assert.equal(decideAccess(undefined, NOW).entitled, false);
    const account = {
      did: USER_DID,
      subscriptions: { sub_1: deriveSubscriptionState(sub(), nowS) },
      updatedAt: NOW.toISOString(),
    };
    assert.equal(decideAccess(account, NOW).entitled, true);
    assert.equal(
      decideAccess({ ...account, hold: { reason: "dispute", since: "" } }, NOW)
        .reason,
      "hold",
    );
    assert.equal(
      decideAccess(account, new Date((nowS + 30 * DAY) * 1000)).reason,
      "expired",
    );
  });
});

describe("webhook processing", () => {
  it("links the DID on checkout and publishes a minimal entitlement", async () => {
    const h = harness({ sub_1: sub() });
    const outcome = await handleStripeEvent(checkoutCompleted(), h.deps);
    assert.deepEqual(outcome, {
      status: "applied",
      did: USER_DID,
      entitled: true,
    });
    assert.equal(await h.store.findDidByCustomer("cus_1"), USER_DID);

    const record = h.published.get(USER_DID)!;
    assert.deepEqual(Object.keys(record).sort(), [
      "$type",
      "issuedAt",
      "subject",
      "tier",
      "validUntil",
    ]);
    assert.ok(
      !JSON.stringify(record).includes("cus_"),
      "no Stripe identifiers are published",
    );
    assert.ok(!JSON.stringify(record).includes("sub_"));
  });

  it("ignores duplicate deliveries", async () => {
    const h = harness({ sub_1: sub() });
    const e = checkoutCompleted();
    await handleStripeEvent(e, h.deps);
    assert.deepEqual(await handleStripeEvent(e, h.deps), {
      status: "duplicate",
    });
    assert.equal(h.retrievals(), 1);
  });

  it("uses current Stripe state, so a late stale event cannot restore access", async () => {
    const h = harness({ sub_1: sub() });
    await handleStripeEvent(checkoutCompleted(), h.deps);
    // The subscription is cancelled; Stripe then delivers an *older* "updated"
    // event (still saying active) after the deletion event.
    h.subscriptions.sub_1 = sub({ status: "canceled" });
    await handleStripeEvent(
      event(
        "customer.subscription.deleted",
        sub({ status: "canceled" }) as never,
      ),
      h.deps,
    );
    const stale = event(
      "customer.subscription.updated",
      sub({ status: "active" }) as never,
    );
    const outcome = await handleStripeEvent(stale, h.deps);
    assert.deepEqual(outcome, {
      status: "applied",
      did: USER_DID,
      entitled: false,
    });
    assert.equal(
      h.published.has(USER_DID),
      false,
      "entitlement record removed",
    );
  });

  it("keeps access while a second subscription is still active", async () => {
    const h = harness({ sub_1: sub(), sub_2: sub({ id: "sub_2" }) });
    await handleStripeEvent(checkoutCompleted(), h.deps);
    await handleStripeEvent(
      event("customer.subscription.created", { id: "sub_2" }),
      h.deps,
    );
    h.subscriptions.sub_1 = sub({ status: "canceled" });
    const outcome = await handleStripeEvent(
      event("customer.subscription.deleted", { id: "sub_1" }),
      h.deps,
    );
    assert.equal(outcome.status === "applied" && outcome.entitled, true);
  });

  it("refreshes on invoice events, including the newer invoice shape", async () => {
    const h = harness({ sub_1: sub() });
    await handleStripeEvent(checkoutCompleted(), h.deps);
    h.subscriptions.sub_1 = sub({
      status: "past_due",
      items: {
        data: [
          {
            current_period_start: nowS - 5 * DAY,
            current_period_end: nowS + 25 * DAY,
          },
        ],
      },
    });
    const outcome = await handleStripeEvent(
      event("invoice.payment_failed", {
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
      h.deps,
    );
    assert.deepEqual(outcome, {
      status: "applied",
      did: USER_DID,
      entitled: false,
    });
  });

  it("puts a hold on disputes and full refunds until cleared", async () => {
    const h = harness({ sub_1: sub() });
    await handleStripeEvent(checkoutCompleted(), h.deps);

    const partial = await handleStripeEvent(
      event("charge.refunded", {
        customer: "cus_1",
        amount: 500,
        amount_refunded: 100,
      }),
      h.deps,
    );
    assert.equal(partial.status, "ignored");

    const dispute = await handleStripeEvent(
      event("charge.dispute.created", { charge: "ch_1" }),
      h.deps,
    );
    assert.deepEqual(dispute, {
      status: "applied",
      did: USER_DID,
      entitled: false,
    });
    // A later renewal does not lift the hold by itself.
    const renewal = await handleStripeEvent(
      event("invoice.paid", { subscription: "sub_1" }),
      h.deps,
    );
    assert.equal(renewal.status === "applied" && renewal.entitled, false);

    await clearHold(USER_DID, h.deps);
    assert.equal(
      decideAccess(await h.store.getAccount(USER_DID), NOW).entitled,
      true,
    );
    assert.ok(h.published.has(USER_DID));
  });

  it("rejects mismatched DID bindings and foreign-mode events", async () => {
    const h = harness({ sub_1: sub() });
    const mismatched = event("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: OTHER_DID,
      metadata: { did: USER_DID },
      subscription: "sub_1",
    });
    assert.equal(
      (await handleStripeEvent(mismatched, h.deps)).status,
      "ignored",
    );
    assert.equal(
      (await handleStripeEvent(checkoutCompleted(OTHER_DID), h.deps)).status,
      "ignored",
    );

    const live = event("customer.subscription.updated", { id: "sub_1" }, true);
    assert.equal((await handleStripeEvent(live, h.deps)).status, "ignored");
    assert.equal(await h.store.getAccount(USER_DID), undefined);
  });

  it("never lets one Stripe customer serve two DIDs", async () => {
    const h = harness({
      sub_1: sub(),
      sub_9: sub({ id: "sub_9", metadata: { did: OTHER_DID } }),
    });
    await handleStripeEvent(checkoutCompleted(), h.deps);
    const outcome = await handleStripeEvent(
      event("customer.subscription.created", { id: "sub_9" }),
      h.deps,
    );
    assert.equal(outcome.status, "ignored");
    assert.equal(await h.store.getAccount(OTHER_DID), undefined);
  });
});

describe("public entitlement verification", () => {
  const record: EntitlementRecord = {
    $type: ENTITLEMENT_COLLECTION,
    subject: USER_DID,
    tier: "managed",
    validUntil: "2026-12-01T00:00:00Z",
    issuedAt: "2026-11-01T00:00:00Z",
  };
  const uri = `at://${SERVICE_DID}/${ENTITLEMENT_COLLECTION}/${USER_DID}`;

  it("accepts only records in the pinned service repository", () => {
    assert.ok(
      validateEntitlementRecord(
        { uri, value: record },
        USER_DID,
        SERVICE_DID,
        NOW,
      ),
    );
    const impostor = `at://${OTHER_DID}/${ENTITLEMENT_COLLECTION}/${USER_DID}`;
    assert.equal(
      validateEntitlementRecord(
        { uri: impostor, value: record },
        USER_DID,
        SERVICE_DID,
        NOW,
      ),
      undefined,
    );
    assert.equal(
      validateEntitlementRecord(
        { uri, value: { ...record, subject: OTHER_DID } },
        USER_DID,
        SERVICE_DID,
        NOW,
      ),
      undefined,
    );
    assert.equal(
      validateEntitlementRecord(
        { uri, value: record },
        USER_DID,
        SERVICE_DID,
        new Date("2026-12-02T00:00:00Z"),
      ),
      undefined,
    );
  });

  it("reads from the service DID's PDS and fails closed on outages", async () => {
    const { fetcher, calls } = mockFetch(
      plc({ [SERVICE_DID]: SERVICE_PDS }),
      (url) =>
        url.origin === SERVICE_PDS ? json({ uri, value: record }) : undefined,
    );
    const ok = await verifyPublicEntitlement(USER_DID, SERVICE_DID, {
      fetch: fetcher,
      lookup: publicLookup,
      now: () => NOW,
    });
    assert.equal(ok?.tier, "managed");
    const read = calls.find((c) => c.url.pathname.endsWith("getRecord"))!;
    assert.equal(read.url.searchParams.get("repo"), SERVICE_DID);
    assert.equal(read.url.searchParams.get("rkey"), USER_DID);

    const down = mockFetch(() => json({ error: "InternalServerError" }, 503));
    assert.equal(
      await verifyPublicEntitlement(USER_DID, SERVICE_DID, {
        fetch: down.fetcher,
        lookup: publicLookup,
        now: () => NOW,
      }),
      undefined,
    );
  });
});
