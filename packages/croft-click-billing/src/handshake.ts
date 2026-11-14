/**
 * DID-control handshake.
 *
 * The croft.click tools authenticate with ATProto OAuth in the browser, so
 * the server cannot see or trust that OAuth session directly. Instead:
 *
 * 1. The browser asks the server for a challenge for its DID.
 * 2. The server returns a random nonce, a record key, and a separate secret
 *    that the browser keeps (an HttpOnly cookie in practice).
 * 3. Using its OAuth session, the browser writes a
 *    `click.croft.auth.handshake` record containing the nonce into the
 *    user's own repository under that record key.
 * 4. The browser asks the server to complete the handshake, presenting the
 *    secret. The server reads the record from the PDS named in the DID's
 *    own DID document — never from a client-supplied URI — checks every
 *    field, and consumes the challenge so it cannot be used again.
 *
 * Only someone able to write to the DID's repository can do step 3, which
 * is the proof of control. The secret in step 4 stops someone who merely
 * watches the firehose from racing the real user to complete their
 * challenge, since the nonce becomes public once the record is written.
 */

import {
  getRecordFromPds,
  isAtprotoDid,
  resolvePds,
  type ResolveOptions,
} from "./did.js";
import { randomToken, safeEqual, sha256Base64url } from "./encoding.js";
import type { ChallengeStore, StoredChallenge } from "./store.js";

export const HANDSHAKE_COLLECTION = "click.croft.auth.handshake";
export const DEFAULT_CHALLENGE_TTL_SECONDS = 10 * 60;
/** Allowed clock disagreement between this server and the user's client. */
const CLOCK_SKEW_MS = 2 * 60 * 1000;

export interface HandshakeRecord {
  $type: typeof HANDSHAKE_COLLECTION;
  service: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
}

export interface IssuedChallenge {
  /** Public: what the browser needs to write the record. */
  collection: typeof HANDSHAKE_COLLECTION;
  rkey: string;
  /** Use this exact value as the record (set createdAt to now when writing). */
  record: Omit<HandshakeRecord, "createdAt">;
  /** Private: return to the browser only in an HttpOnly cookie. */
  secret: string;
  expiresAt: string;
}

export interface HandshakeOptions extends ResolveOptions {
  /** DID of the official croft.click service. Binds the record to this service. */
  serviceDid: string;
  store: ChallengeStore;
  ttlSeconds?: number;
  now?: () => Date;
}

export class HandshakeError extends Error {
  constructor(
    readonly code:
      | "invalid_did"
      | "unknown_challenge"
      | "bad_secret"
      | "expired"
      | "record_missing"
      | "record_invalid"
      | "already_used"
      | "resolution_failed",
    message: string,
  ) {
    super(message);
    this.name = "HandshakeError";
  }
}

export async function issueChallenge(
  did: string,
  options: HandshakeOptions,
): Promise<IssuedChallenge> {
  if (!isAtprotoDid(did)) {
    throw new HandshakeError("invalid_did", "A did:plc or did:web is required");
  }
  const now = (options.now ?? (() => new Date()))();
  const ttl = options.ttlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  const secret = randomToken(32);
  const stored: StoredChallenge = {
    // 16 random bytes → 22 base64url chars, a valid ATProto record key.
    id: randomToken(16),
    did,
    nonce: randomToken(32),
    secretHash: sha256Base64url(secret),
    issuedAt: now.toISOString(),
    expiresAt,
  };
  await options.store.putChallenge(stored);
  return {
    collection: HANDSHAKE_COLLECTION,
    rkey: stored.id,
    record: {
      $type: HANDSHAKE_COLLECTION,
      service: options.serviceDid,
      nonce: stored.nonce,
      expiresAt,
    },
    secret,
    expiresAt,
  };
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** Pure check of a fetched record against the stored challenge. */
export function validateHandshakeRecord(
  record: { uri: string; value: unknown },
  challenge: StoredChallenge,
  serviceDid: string,
  now: Date,
): string | undefined {
  const expectedUri = `at://${challenge.did}/${HANDSHAKE_COLLECTION}/${challenge.id}`;
  if (record.uri !== expectedUri)
    return "record URI does not match the challenge";
  const value = record.value as Partial<HandshakeRecord> | null;
  if (!value || typeof value !== "object")
    return "record value is not an object";
  if (value.$type !== HANDSHAKE_COLLECTION) return "unexpected record type";
  if (value.service !== serviceDid)
    return "record is bound to a different service";
  if (
    typeof value.nonce !== "string" ||
    !safeEqual(value.nonce, challenge.nonce)
  ) {
    return "nonce does not match";
  }
  const createdAt = parseTime(value.createdAt);
  const issuedAt = Date.parse(challenge.issuedAt);
  if (
    createdAt === undefined ||
    createdAt < issuedAt - CLOCK_SKEW_MS ||
    createdAt > now.getTime() + CLOCK_SKEW_MS
  ) {
    return "createdAt is outside the challenge window";
  }
  const recordExpiry = parseTime(value.expiresAt);
  if (
    recordExpiry === undefined ||
    recordExpiry > Date.parse(challenge.expiresAt)
  ) {
    return "expiresAt is missing or later than the challenge allows";
  }
  return undefined;
}

/**
 * Verify the user's handshake record and consume the challenge. Resolves to
 * the proven DID, which is the only identity the caller should trust.
 */
export async function completeHandshake(
  challengeId: string,
  secret: string,
  options: HandshakeOptions,
): Promise<{ did: string }> {
  const now = (options.now ?? (() => new Date()))();
  const challenge = await options.store.getChallenge(challengeId);
  if (!challenge) {
    throw new HandshakeError(
      "unknown_challenge",
      "Challenge not found or already used",
    );
  }
  if (!safeEqual(sha256Base64url(secret), challenge.secretHash)) {
    throw new HandshakeError("bad_secret", "Challenge secret does not match");
  }
  if (now.getTime() > Date.parse(challenge.expiresAt)) {
    await options.store.consumeChallenge(challengeId);
    throw new HandshakeError("expired", "Challenge has expired");
  }

  let record;
  try {
    const pds = await resolvePds(challenge.did, options);
    record = await getRecordFromPds(
      pds,
      challenge.did,
      HANDSHAKE_COLLECTION,
      challenge.id,
      options.fetch,
    );
  } catch (error) {
    throw new HandshakeError(
      "resolution_failed",
      `Could not read the handshake record: ${(error as Error).message}`,
    );
  }
  if (!record) {
    // Not consumed: the record may not have propagated yet, so the client can retry.
    throw new HandshakeError(
      "record_missing",
      "Handshake record not found yet",
    );
  }
  const problem = validateHandshakeRecord(
    record,
    challenge,
    options.serviceDid,
    now,
  );
  if (problem) {
    await options.store.consumeChallenge(challengeId);
    throw new HandshakeError("record_invalid", problem);
  }
  if (!(await options.store.consumeChallenge(challengeId))) {
    throw new HandshakeError("already_used", "Challenge was already used");
  }
  return { did: challenge.did };
}
