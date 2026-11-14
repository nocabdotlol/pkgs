/**
 * One object wiring the pieces together for a server route handler.
 * Framework-agnostic: it takes and returns plain values, so SvelteKit (or
 * anything else) only has to move cookies and bodies around.
 */

import type { BillingConfig } from "./config.js";
import type { LookupFn } from "./did.js";
import {
  decideAccess,
  type AccessDecision,
  type AccessPolicy,
  type EntitlementPublisher,
} from "./entitlement.js";
import {
  completeHandshake,
  issueChallenge,
  type IssuedChallenge,
} from "./handshake.js";
import {
  createSession,
  revokeSession,
  verifySession,
  type Session,
  type SessionOptions,
} from "./session.js";
import type {
  BillingStore,
  ChallengeStore,
  SessionRevocationStore,
} from "./store.js";
import { StripeClient, verifyStripeWebhook } from "./stripe.js";
import { handleStripeEvent, type WebhookOutcome } from "./webhook.js";

export interface CroftBillingDeps {
  config: BillingConfig;
  store: BillingStore & ChallengeStore & SessionRevocationStore;
  publisher?: EntitlementPublisher;
  policy?: AccessPolicy;
  fetch?: typeof fetch;
  lookup?: LookupFn;
  now?: () => Date;
  /** Stripe API version to pin. Set to the version the integration was tested with. */
  stripeApiVersion?: string;
}

export class CroftBilling {
  readonly stripe: StripeClient;
  private readonly sessionOptions: SessionOptions;

  constructor(private readonly deps: CroftBillingDeps) {
    if (deps.config.publishEntitlements && !deps.publisher) {
      throw new Error(
        "CROFT_PUBLISH_ENTITLEMENTS is on but no publisher was provided",
      );
    }
    this.stripe = new StripeClient({
      secretKey: deps.config.stripeSecretKey,
      fetch: deps.fetch,
      apiVersion: deps.stripeApiVersion,
    });
    this.sessionOptions = {
      secrets: deps.config.sessionSecrets,
      revocations: deps.store,
      now: deps.now,
    };
  }

  private get handshakeOptions() {
    return {
      serviceDid: this.deps.config.serviceDid,
      store: this.deps.store,
      fetch: this.deps.fetch,
      lookup: this.deps.lookup,
      now: this.deps.now,
    };
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  beginHandshake(did: string): Promise<IssuedChallenge> {
    return issueChallenge(did, this.handshakeOptions);
  }

  /** Verify the handshake record and mint a session token for the proven DID. */
  async completeHandshake(challengeId: string, secret: string) {
    const { did } = await completeHandshake(
      challengeId,
      secret,
      this.handshakeOptions,
    );
    return createSession(did, this.sessionOptions);
  }

  getSession(token: string | undefined): Promise<Session | undefined> {
    return verifySession(token, this.sessionOptions);
  }

  logout(session: Session): Promise<void> {
    return revokeSession(session, this.sessionOptions);
  }

  /** Fails closed: any store error means "not entitled", i.e. the free tier. */
  async getAccess(did: string): Promise<AccessDecision> {
    try {
      return decideAccess(await this.deps.store.getAccount(did), this.now());
    } catch {
      return {
        entitled: false,
        tier: null,
        until: null,
        reason: "no_subscription",
      };
    }
  }

  /**
   * Where to send a signed-in user who wants to pay. An already-entitled DID
   * goes to the Customer Portal instead, so nobody pays twice by accident.
   */
  async checkoutUrl(session: Session): Promise<string> {
    const account = await this.deps.store.getAccount(session.did);
    if (
      decideAccess(account, this.now()).entitled &&
      account?.stripeCustomerId
    ) {
      return this.portalUrl(session);
    }
    const origin = this.deps.config.publicOrigin;
    const checkout = await this.stripe.createCheckoutSession({
      did: session.did,
      priceId: this.deps.config.stripePriceId,
      successUrl: `${origin}/billing?checkout=success`,
      cancelUrl: `${origin}/billing?checkout=cancelled`,
      customerId: account?.stripeCustomerId,
      // Double-clicks within one session reuse the same Checkout Session.
      idempotencyKey: `checkout:${session.sid}`,
    });
    return checkout.url;
  }

  async portalUrl(session: Session): Promise<string> {
    const account = await this.deps.store.getAccount(session.did);
    if (!account?.stripeCustomerId)
      throw new Error("No billing account for this DID");
    const portal = await this.stripe.createPortalSession({
      customerId: account.stripeCustomerId,
      returnUrl: `${this.deps.config.publicOrigin}/billing`,
    });
    return portal.url;
  }

  handleWebhook(
    rawBody: string,
    signature: string | null,
  ): Promise<WebhookOutcome> {
    const event = verifyStripeWebhook(
      rawBody,
      signature,
      this.deps.config.stripeWebhookSecrets,
      {
        now: this.deps.now,
      },
    );
    return handleStripeEvent(event, {
      store: this.deps.store,
      stripe: this.stripe,
      publisher: this.deps.config.publishEntitlements
        ? this.deps.publisher
        : undefined,
      policy: this.deps.policy,
      livemode: this.deps.config.mode === "live",
      now: this.deps.now,
    });
  }
}
