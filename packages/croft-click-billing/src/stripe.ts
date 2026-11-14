/**
 * Minimal Stripe REST client and webhook signature verification.
 *
 * This talks to the Stripe API directly with fetch rather than pulling in
 * the Stripe SDK, because only four calls are needed. Products and prices
 * are created in the Stripe Dashboard, not from this repository.
 */

import { hmacSha256, safeEqual } from "./encoding.js";

const STRIPE_API = "https://api.stripe.com";
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export type BillingMode = "test" | "live";

/** Refuse to run test configuration with live keys, and vice versa. */
export function assertStripeKeyMode(
  secretKey: string,
  mode: BillingMode,
): void {
  const match = secretKey.match(/^(sk|rk)_(test|live)_/);
  if (!match)
    throw new Error(
      "STRIPE_SECRET_KEY is not a Stripe secret or restricted key",
    );
  if (match[2] !== mode) {
    throw new Error(
      `STRIPE_SECRET_KEY is a ${match[2]} key but CROFT_BILLING_MODE is ${mode}`,
    );
  }
}

type FormValue =
  | string
  | number
  | boolean
  | undefined
  | FormValue[]
  | { [key: string]: FormValue };

/** Stripe's bracketed form encoding: a[b][0][c]=v */
export function encodeStripeForm(params: Record<string, FormValue>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: FormValue): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
    } else if (typeof value === "object") {
      for (const [key, item] of Object.entries(value))
        walk(`${prefix}[${key}]`, item);
    } else {
      pairs.push(
        `${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`,
      );
    }
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return pairs.join("&");
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

export interface StripeSubscription {
  id: string;
  object: "subscription";
  status: string;
  customer: string | { id: string };
  metadata?: Record<string, string>;
  cancel_at_period_end?: boolean;
  // Older API versions put the period on the subscription; newer ones put it
  // on each item. Both are read.
  current_period_start?: number;
  current_period_end?: number;
  items?: {
    data?: Array<{
      current_period_start?: number;
      current_period_end?: number;
    }>;
  };
}

export interface StripeClientOptions {
  secretKey: string;
  fetch?: typeof fetch;
  /** Pin the API version the code was tested against. */
  apiVersion?: string;
  apiBase?: string;
}

export class StripeClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: StripeClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, FormValue> = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const url = new URL(path, this.options.apiBase ?? STRIPE_API);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.secretKey}`,
    };
    if (this.options.apiVersion)
      headers["stripe-version"] = this.options.apiVersion;
    let body: string | undefined;
    if (method === "GET") {
      url.search = encodeStripeForm(params);
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      body = encodeStripeForm(params);
    }
    const response = await this.fetcher(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => ({}))) as {
      error?: { type?: string; message?: string };
    };
    if (!response.ok) {
      throw new StripeApiError(
        response.status,
        json.error?.type,
        json.error?.message ?? `Stripe returned ${response.status}`,
      );
    }
    return json as T;
  }

  /**
   * Checkout for one subscription, bound to a DID through server-set
   * metadata. No email or name is passed: Stripe collects what it needs.
   */
  createCheckoutSession(input: {
    did: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    customerId?: string;
    idempotencyKey?: string;
  }): Promise<{ id: string; url: string }> {
    return this.request(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "subscription",
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.did,
        customer: input.customerId,
        metadata: { did: input.did },
        subscription_data: { metadata: { did: input.did } },
      },
      input.idempotencyKey,
    );
  }

  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ id: string; url: string }> {
    return this.request("POST", "/v1/billing_portal/sessions", {
      customer: input.customerId,
      return_url: input.returnUrl,
    });
  }

  retrieveSubscription(id: string): Promise<StripeSubscription> {
    return this.request("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
  }

  retrieveCharge(
    id: string,
  ): Promise<{ id: string; customer: string | { id: string } | null }> {
    return this.request("GET", `/v1/charges/${encodeURIComponent(id)}`);
  }
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/**
 * Verify a `Stripe-Signature` header against the raw request body and parse
 * the event. The body must be the exact bytes Stripe sent, not re-serialised
 * JSON. Several secrets may be given to allow rotation.
 */
export function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secrets: string[],
  options: { toleranceSeconds?: number; now?: () => Date } = {},
): StripeEvent {
  if (!signatureHeader)
    throw new WebhookSignatureError("Missing Stripe-Signature header");
  if (!secrets.length)
    throw new WebhookSignatureError("No webhook secret configured");

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim());
    if (key === "t" && value) timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || !Number.isInteger(timestamp) || !signatures.length) {
    throw new WebhookSignatureError("Malformed Stripe-Signature header");
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const matched = secrets.some((secret) => {
    const expected = hmacSha256(secret, signedPayload, "hex");
    return signatures.some((candidate) => safeEqual(expected, candidate));
  });
  if (!matched) throw new WebhookSignatureError("Signature does not match");

  const now = Math.floor(
    (options.now ?? (() => new Date()))().getTime() / 1000,
  );
  const tolerance =
    options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookSignatureError(
      "Signature timestamp is outside the tolerance",
    );
  }

  const event = JSON.parse(rawBody) as StripeEvent;
  if (typeof event?.id !== "string" || typeof event.type !== "string") {
    throw new WebhookSignatureError("Body is not a Stripe event");
  }
  return event;
}

/** Test helper and documentation of the signing scheme. */
export function signStripePayload(
  rawBody: string,
  secret: string,
  timestamp: number,
): string {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${rawBody}`, "hex")}`;
}
