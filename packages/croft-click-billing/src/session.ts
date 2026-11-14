/**
 * Short-lived web sessions for the managed service.
 *
 * A session is a signed, stateless token naming a DID, issued only after a
 * successful handshake. There is no password and no device binding: to
 * regain access on another device, the user authenticates through ATProto
 * and completes a new handshake. Logging out revokes the session only; it
 * never touches billing. Billing cancellation never ends a session; it only
 * changes what the session's DID is entitled to.
 */

import { hmacSha256, randomToken, safeEqual } from "./encoding.js";
import type { SessionRevocationStore } from "./store.js";

export const SESSION_COOKIE = "__Host-croft_session";
export const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export interface Session {
  v: 1;
  sid: string;
  did: string;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expires at, unix seconds. */
  exp: number;
}

export interface SessionOptions {
  /**
   * Signing secrets. The first signs new sessions; every entry verifies, so
   * rotating means prepending a new secret and later dropping the old one.
   * Dropping all old secrets logs everyone out.
   */
  secrets: string[];
  ttlSeconds?: number;
  revocations?: SessionRevocationStore;
  now?: () => Date;
}

function assertSecrets(secrets: string[]): void {
  if (!secrets.length || secrets.some((s) => s.length < MIN_SECRET_LENGTH)) {
    throw new Error(
      `Session secrets must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
}

function nowSeconds(options: SessionOptions): number {
  return Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
}

export function createSession(
  did: string,
  options: SessionOptions,
): { token: string; session: Session } {
  assertSecrets(options.secrets);
  const iat = nowSeconds(options);
  const session: Session = {
    v: 1,
    sid: randomToken(16),
    did,
    iat,
    exp: iat + (options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS),
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url",
  );
  const signature = hmacSha256(options.secrets[0], payload, "base64url");
  return { token: `${payload}.${signature}`, session };
}

export async function verifySession(
  token: string | undefined,
  options: SessionOptions,
): Promise<Session | undefined> {
  assertSecrets(options.secrets);
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [payload, signature] = parts;
  const valid = options.secrets.some((secret) =>
    safeEqual(hmacSha256(secret, payload, "base64url"), signature),
  );
  if (!valid) return undefined;

  let session: Session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    session?.v !== 1 ||
    typeof session.sid !== "string" ||
    typeof session.did !== "string" ||
    typeof session.exp !== "number" ||
    session.exp <= nowSeconds(options)
  ) {
    return undefined;
  }
  if (
    options.revocations &&
    (await options.revocations.isSessionRevoked(session.sid))
  ) {
    return undefined;
  }
  return session;
}

export async function revokeSession(
  session: Session,
  options: SessionOptions,
): Promise<void> {
  await options.revocations?.revokeSession(session.sid, session.exp);
}

/** Set-Cookie value for a session. `__Host-` requires Secure, Path=/ and no Domain. */
export function sessionCookie(token: string, session: Session): string {
  const maxAge = Math.max(0, session.exp - session.iat);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
