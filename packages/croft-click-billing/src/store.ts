/**
 * The minimal private state the managed service keeps.
 *
 * There is deliberately no profile, email or password here. Everything is
 * keyed by DID, and the only billing data held is the Stripe customer and
 * subscription references needed to open the Customer Portal and to map
 * webhook events back to a DID. The backing database is a hosting decision
 * (see docs/croft-click/hosting.md); production implementations must make
 * `consumeChallenge` and `updateAccount` atomic.
 */

export interface StoredChallenge {
  /** Also the record key the user writes the handshake record under. */
  id: string;
  did: string;
  nonce: string;
  /** SHA-256 of the browser-held secret. The secret itself is never stored. */
  secretHash: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SubscriptionState {
  status: string;
  /** ISO time until which this subscription grants access, or null for none. */
  accessUntil: string | null;
  /** Stripe `event.created`/refetch time this state was derived at (unix seconds). */
  observedAt: number;
}

export type AccessHold = "dispute" | "refund";

export interface BillingAccount {
  did: string;
  stripeCustomerId?: string;
  /** Keyed by Stripe subscription ID. Access is the best of any of them. */
  subscriptions: Record<string, SubscriptionState>;
  /**
   * A hold suspends access regardless of subscription state, for example
   * after a chargeback. Only cleared deliberately by the maintainer.
   */
  hold?: { reason: AccessHold; since: string };
  updatedAt: string;
}

export interface ChallengeStore {
  putChallenge(challenge: StoredChallenge): Promise<void>;
  getChallenge(id: string): Promise<StoredChallenge | undefined>;
  /** Atomically delete. Resolves true only for the single caller that removed it. */
  consumeChallenge(id: string): Promise<boolean>;
}

export interface BillingStore {
  getAccount(did: string): Promise<BillingAccount | undefined>;
  /** Atomic read-modify-write for one DID. */
  updateAccount(
    did: string,
    mutate: (current: BillingAccount | undefined) => BillingAccount,
  ): Promise<BillingAccount>;
  findDidByCustomer(customerId: string): Promise<string | undefined>;
  hasProcessedEvent(eventId: string): Promise<boolean>;
  markEventProcessed(eventId: string): Promise<void>;
  /** Forget a DID entirely (data-removal requests). */
  deleteAccount(did: string): Promise<void>;
}

export interface SessionRevocationStore {
  revokeSession(sessionId: string, expiresAt: number): Promise<void>;
  isSessionRevoked(sessionId: string): Promise<boolean>;
}

/**
 * In-memory implementation for tests and local development only. It does not
 * survive restarts and is not shared between serverless instances.
 */
export class MemoryStore
  implements ChallengeStore, BillingStore, SessionRevocationStore
{
  private challenges = new Map<string, StoredChallenge>();
  private accounts = new Map<string, BillingAccount>();
  private events = new Set<string>();
  private revoked = new Map<string, number>();

  async putChallenge(challenge: StoredChallenge): Promise<void> {
    this.challenges.set(challenge.id, { ...challenge });
  }
  async getChallenge(id: string): Promise<StoredChallenge | undefined> {
    const found = this.challenges.get(id);
    return found ? { ...found } : undefined;
  }
  async consumeChallenge(id: string): Promise<boolean> {
    return this.challenges.delete(id);
  }

  async getAccount(did: string): Promise<BillingAccount | undefined> {
    const found = this.accounts.get(did);
    return found ? structuredClone(found) : undefined;
  }
  async updateAccount(
    did: string,
    mutate: (current: BillingAccount | undefined) => BillingAccount,
  ): Promise<BillingAccount> {
    const next = mutate(await this.getAccount(did));
    if (next.did !== did) throw new Error("Account DID cannot change");
    this.accounts.set(did, structuredClone(next));
    return structuredClone(next);
  }
  async findDidByCustomer(customerId: string): Promise<string | undefined> {
    for (const account of this.accounts.values()) {
      if (account.stripeCustomerId === customerId) return account.did;
    }
    return undefined;
  }
  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }
  async markEventProcessed(eventId: string): Promise<void> {
    this.events.add(eventId);
  }
  async deleteAccount(did: string): Promise<void> {
    this.accounts.delete(did);
  }

  async revokeSession(sessionId: string, expiresAt: number): Promise<void> {
    this.revoked.set(sessionId, expiresAt);
  }
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    return this.revoked.has(sessionId);
  }
}
