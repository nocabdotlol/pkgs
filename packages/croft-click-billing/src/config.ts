/**
 * Environment configuration. Secrets are read from the environment only and
 * are never logged or echoed in errors. See README.md for every variable.
 */

import { isAtprotoDid } from "./did.js";
import { assertStripeKeyMode, type BillingMode } from "./stripe.js";

export interface BillingConfig {
  mode: BillingMode;
  stripeSecretKey: string;
  stripeWebhookSecrets: string[];
  stripePriceId: string;
  /** Pinned DID of the croft.click service account: part of the trust root. */
  serviceDid: string;
  sessionSecrets: string[];
  /** Public origin of the billing site, e.g. https://croft.click */
  publicOrigin: string;
  publishEntitlements: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Returns undefined when billing is not configured at all, so deployments
 * without billing (including every self-hosted copy) keep working unchanged.
 * Throws when it is partially or inconsistently configured.
 */
export function loadBillingConfig(
  env: Record<string, string | undefined>,
): BillingConfig | undefined {
  if (!env.STRIPE_SECRET_KEY && !env.CROFT_BILLING_MODE) return undefined;

  const mode = (env.CROFT_BILLING_MODE ?? "test") as BillingMode;
  if (mode !== "test" && mode !== "live") {
    throw new ConfigError("CROFT_BILLING_MODE must be 'test' or 'live'");
  }
  const required = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
    "CROFT_SERVICE_DID",
    "CROFT_SESSION_SECRET",
    "CROFT_PUBLIC_ORIGIN",
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length)
    throw new ConfigError(
      `Missing billing configuration: ${missing.join(", ")}`,
    );

  const stripeSecretKey = env.STRIPE_SECRET_KEY!;
  try {
    assertStripeKeyMode(stripeSecretKey, mode);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  const stripeWebhookSecrets = list(env.STRIPE_WEBHOOK_SECRET);
  if (stripeWebhookSecrets.some((secret) => !secret.startsWith("whsec_"))) {
    throw new ConfigError(
      "STRIPE_WEBHOOK_SECRET entries must start with whsec_",
    );
  }
  const stripePriceId = env.STRIPE_PRICE_ID!;
  if (!stripePriceId.startsWith("price_")) {
    throw new ConfigError(
      "STRIPE_PRICE_ID must be a Stripe price ID (price_…)",
    );
  }
  const serviceDid = env.CROFT_SERVICE_DID!;
  if (!isAtprotoDid(serviceDid)) {
    throw new ConfigError("CROFT_SERVICE_DID must be a did:plc or did:web");
  }
  const sessionSecrets = list(env.CROFT_SESSION_SECRET);
  if (sessionSecrets.some((secret) => secret.length < 32)) {
    throw new ConfigError(
      "CROFT_SESSION_SECRET entries must be at least 32 characters",
    );
  }
  let origin: URL;
  try {
    origin = new URL(env.CROFT_PUBLIC_ORIGIN!);
  } catch {
    throw new ConfigError("CROFT_PUBLIC_ORIGIN must be a URL");
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  if (origin.protocol !== "https:" && !(mode === "test" && isLoopback)) {
    throw new ConfigError(
      "CROFT_PUBLIC_ORIGIN must be HTTPS (loopback http is allowed in test mode)",
    );
  }

  return {
    mode,
    stripeSecretKey,
    stripeWebhookSecrets,
    stripePriceId,
    serviceDid,
    sessionSecrets,
    publicOrigin: origin.origin,
    publishEntitlements: env.CROFT_PUBLISH_ENTITLEMENTS === "true",
  };
}
