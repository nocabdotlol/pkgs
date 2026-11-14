import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadBillingConfig } from "../config.js";
import {
  createSession,
  revokeSession,
  sessionCookie,
  verifySession,
} from "../session.js";
import { MemoryStore } from "../store.js";
import {
  assertStripeKeyMode,
  encodeStripeForm,
  signStripePayload,
  StripeClient,
  verifyStripeWebhook,
  WebhookSignatureError,
} from "../stripe.js";
import { json, mockFetch, SERVICE_DID, USER_DID } from "./helpers.js";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);
const T0 = new Date("2026-11-14T12:00:00Z");

describe("sessions", () => {
  it("round-trips and rejects tampering", async () => {
    const options = { secrets: [SECRET_A], now: () => T0 };
    const { token, session } = createSession(USER_DID, options);
    assert.equal((await verifySession(token, options))?.did, USER_DID);

    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...session, did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }),
    ).toString("base64url");
    assert.equal(
      await verifySession(`${forged}.${signature}`, options),
      undefined,
    );
    assert.equal(
      await verifySession(`${payload}.x${signature.slice(1)}`, options),
      undefined,
    );
    assert.equal(await verifySession(undefined, options), undefined);
  });

  it("expires", async () => {
    let now = T0;
    const options = { secrets: [SECRET_A], ttlSeconds: 60, now: () => now };
    const { token } = createSession(USER_DID, options);
    now = new Date(T0.getTime() + 61_000);
    assert.equal(await verifySession(token, options), undefined);
  });

  it("supports secret rotation", async () => {
    const { token } = createSession(USER_DID, { secrets: [SECRET_A] });
    assert.ok(await verifySession(token, { secrets: [SECRET_B, SECRET_A] }));
    assert.equal(
      await verifySession(token, { secrets: [SECRET_B] }),
      undefined,
    );
  });

  it("logout revokes the session without touching anything else", async () => {
    const store = new MemoryStore();
    const options = { secrets: [SECRET_A], revocations: store };
    const first = createSession(USER_DID, options);
    const second = createSession(USER_DID, options);
    await revokeSession(first.session, options);
    assert.equal(await verifySession(first.token, options), undefined);
    assert.ok(
      await verifySession(second.token, options),
      "other devices stay signed in",
    );
  });

  it("refuses short secrets and builds a __Host- cookie", () => {
    assert.throws(() => createSession(USER_DID, { secrets: ["short"] }));
    const { token, session } = createSession(USER_DID, { secrets: [SECRET_A] });
    const cookie = sessionCookie(token, session);
    assert.match(cookie, /^__Host-croft_session=/);
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Max-Age=86400$/);
  });
});

describe("Stripe webhook signatures", () => {
  const body = JSON.stringify({
    id: "evt_1",
    type: "invoice.paid",
    created: 1,
    livemode: false,
    data: { object: {} },
  });
  const ts = Math.floor(T0.getTime() / 1000);
  const now = () => T0;

  it("accepts a valid signature", () => {
    const header = signStripePayload(body, "whsec_test", ts);
    assert.equal(
      verifyStripeWebhook(body, header, ["whsec_test"], { now }).id,
      "evt_1",
    );
  });

  it("accepts any configured secret during rotation", () => {
    const header = signStripePayload(body, "whsec_old", ts);
    assert.ok(
      verifyStripeWebhook(body, header, ["whsec_new", "whsec_old"], { now }),
    );
  });

  it("rejects a wrong secret, altered body, missing header and stale timestamp", () => {
    const header = signStripePayload(body, "whsec_test", ts);
    assert.throws(
      () => verifyStripeWebhook(body, header, ["whsec_other"], { now }),
      WebhookSignatureError,
    );
    assert.throws(
      () => verifyStripeWebhook(body + " ", header, ["whsec_test"], { now }),
      WebhookSignatureError,
    );
    assert.throws(
      () => verifyStripeWebhook(body, null, ["whsec_test"], { now }),
      WebhookSignatureError,
    );
    assert.throws(
      () => verifyStripeWebhook(body, "garbage", ["whsec_test"], { now }),
      WebhookSignatureError,
    );
    const stale = signStripePayload(body, "whsec_test", ts - 301);
    assert.throws(
      () => verifyStripeWebhook(body, stale, ["whsec_test"], { now }),
      /tolerance/,
    );
  });
});

describe("Stripe client", () => {
  it("encodes nested form parameters the way Stripe expects", () => {
    assert.equal(
      encodeStripeForm({
        mode: "subscription",
        line_items: [{ price: "price_1", quantity: 1 }],
        metadata: { did: USER_DID },
        customer: undefined,
      }),
      "mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Bdid%5D=did%3Aplc%3Aabcdefghijklmnopqrstuvwx",
    );
  });

  it("binds Checkout to the DID via server-set metadata and sends no email", async () => {
    const { fetcher, calls } = mockFetch(() =>
      json({ id: "cs_1", url: "https://checkout.stripe.com/c/1" }),
    );
    const stripe = new StripeClient({ secretKey: "sk_test_x", fetch: fetcher });
    const result = await stripe.createCheckoutSession({
      did: USER_DID,
      priceId: "price_1",
      successUrl: "https://croft.click/billing?checkout=success",
      cancelUrl: "https://croft.click/billing?checkout=cancelled",
      idempotencyKey: "checkout:abc",
    });
    assert.equal(result.url, "https://checkout.stripe.com/c/1");
    const [{ url, init }] = calls;
    assert.equal(url.href, "https://api.stripe.com/v1/checkout/sessions");
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("client_reference_id"), USER_DID);
    assert.equal(form.get("metadata[did]"), USER_DID);
    assert.equal(form.get("subscription_data[metadata][did]"), USER_DID);
    assert.equal(form.get("customer_email"), null);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["idempotency-key"], "checkout:abc");
    assert.equal(headers.authorization, "Bearer sk_test_x");
  });

  it("refuses to mix test and live keys", () => {
    assert.doesNotThrow(() => assertStripeKeyMode("sk_test_123", "test"));
    assert.doesNotThrow(() => assertStripeKeyMode("rk_live_123", "live"));
    assert.throws(() => assertStripeKeyMode("sk_live_123", "test"), /live key/);
    assert.throws(() => assertStripeKeyMode("sk_test_123", "live"), /test key/);
    assert.throws(() => assertStripeKeyMode("pk_test_123", "test"));
  });
});

describe("configuration", () => {
  const env = {
    CROFT_BILLING_MODE: "test",
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_WEBHOOK_SECRET: "whsec_a, whsec_b",
    STRIPE_PRICE_ID: "price_123",
    CROFT_SERVICE_DID: SERVICE_DID,
    CROFT_SESSION_SECRET: SECRET_A,
    CROFT_PUBLIC_ORIGIN: "http://127.0.0.1:5173",
  };

  it("is disabled when nothing is configured (self-hosting needs no billing)", () => {
    assert.equal(loadBillingConfig({}), undefined);
  });

  it("loads a complete test configuration", () => {
    const config = loadBillingConfig(env);
    assert.deepEqual(config?.stripeWebhookSecrets, ["whsec_a", "whsec_b"]);
    assert.equal(
      config?.publishEntitlements,
      false,
      "public records are opt-in",
    );
  });

  it("rejects partial, mismatched or insecure configuration", () => {
    assert.throws(
      () => loadBillingConfig({ STRIPE_SECRET_KEY: "sk_test_1" }),
      ConfigError,
    );
    assert.throws(
      () => loadBillingConfig({ ...env, CROFT_BILLING_MODE: "live" }),
      /test key/,
    );
    assert.throws(
      () =>
        loadBillingConfig({
          ...env,
          CROFT_BILLING_MODE: "live",
          STRIPE_SECRET_KEY: "sk_live_1",
        }),
      /HTTPS/,
    );
    assert.throws(
      () => loadBillingConfig({ ...env, CROFT_SERVICE_DID: "croft.click" }),
      /did:plc/,
    );
  });
});
