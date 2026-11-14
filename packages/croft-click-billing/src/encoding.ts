import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Cryptographically random, URL- and record-key-safe token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison. Returns false for different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sha256Base64url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function hmacSha256(
  secret: string,
  data: string,
  encoding: "hex" | "base64url",
): string {
  return createHmac("sha256", secret).update(data, "utf8").digest(encoding);
}
