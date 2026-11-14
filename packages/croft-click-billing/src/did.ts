/**
 * DID resolution for server-side verification.
 *
 * The DID is the only identity croft.click trusts. Handles are never used to
 * look anything up here: a handle can be re-pointed at another DID at any
 * time, so it is display data only.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const DID_PLC = /^did:plc:[a-z2-7]{24}$/;
// ATProto only supports hostname-level did:web (no path segments or ports).
const DID_WEB = /^did:web:[a-zA-Z0-9.-]{1,253}$/;

export const DEFAULT_PLC_DIRECTORY = "https://plc.directory";
const REQUEST_TIMEOUT_MS = 8_000;

export type LookupFn = (
  hostname: string,
) => Promise<Array<{ address: string }>>;

export interface ResolveOptions {
  fetch?: typeof fetch;
  plcDirectory?: string;
  /** DNS lookup used for SSRF checks. Injected in tests. */
  lookup?: LookupFn;
}

export interface DidDocument {
  id: string;
  alsoKnownAs?: string[];
  service?: Array<{ id: string; type: string; serviceEndpoint: unknown }>;
}

/** True for the DID methods ATProto supports (did:plc and did:web). */
export function isAtprotoDid(value: unknown): value is string {
  return (
    typeof value === "string" && (DID_PLC.test(value) || DID_WEB.test(value))
  );
}

const defaultLookup: LookupFn = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

/**
 * Accept only credential-free, default-port HTTPS origins that resolve to
 * public addresses. Every URL taken from a DID document goes through this
 * before the server fetches it.
 */
export async function assertPublicHttpsOrigin(
  value: string,
  lookup: LookupFn = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Endpoint is not a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Endpoint must be a credential-free HTTPS origin");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Endpoint must be an origin");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error("Endpoint is not public");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Endpoint is not public");
    return url;
  }
  const addresses = await lookup(host);
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error("Endpoint did not resolve to public addresses");
  }
  return url;
}

export async function fetchJson<T>(
  fetcher: typeof fetch,
  url: URL,
): Promise<{ status: number; body: T | undefined }> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { status: response.status, body: undefined };
  }
  return { status: response.status, body: (await response.json()) as T };
}

/** Resolve a did:plc or did:web to its DID document. */
export async function resolveDidDocument(
  did: string,
  options: ResolveOptions = {},
): Promise<DidDocument> {
  if (!isAtprotoDid(did)) throw new Error("Unsupported or malformed DID");
  const fetcher = options.fetch ?? fetch;
  const lookup = options.lookup ?? defaultLookup;

  let url: URL;
  if (did.startsWith("did:plc:")) {
    url = new URL(`/${did}`, options.plcDirectory ?? DEFAULT_PLC_DIRECTORY);
  } else {
    const origin = await assertPublicHttpsOrigin(
      `https://${did.slice("did:web:".length)}`,
      lookup,
    );
    url = new URL("/.well-known/did.json", origin);
  }

  const { status, body } = await fetchJson<DidDocument>(fetcher, url);
  if (!body) throw new Error(`DID resolution failed (${status})`);
  if (body.id !== did) throw new Error("DID document id does not match");
  return body;
}

/** The PDS endpoint declared in a DID document, if any. */
export function getPdsEndpoint(doc: DidDocument): string | undefined {
  const service = doc.service?.find(
    (entry) =>
      (entry.id === "#atproto_pds" || entry.id === `${doc.id}#atproto_pds`) &&
      entry.type === "AtprotoPersonalDataServer",
  );
  return typeof service?.serviceEndpoint === "string"
    ? service.serviceEndpoint
    : undefined;
}

/**
 * Resolve a DID to its current, public PDS origin.
 *
 * This is resolved fresh for every verification so that PDS migration is
 * followed automatically: entitlements are keyed by DID, not by PDS.
 */
export async function resolvePds(
  did: string,
  options: ResolveOptions = {},
): Promise<URL> {
  const doc = await resolveDidDocument(did, options);
  const endpoint = getPdsEndpoint(doc);
  if (!endpoint) throw new Error("DID document declares no ATProto PDS");
  return assertPublicHttpsOrigin(
    endpoint.replace(/\/+$/, "") + "/",
    options.lookup ?? defaultLookup,
  );
}

export interface FetchedRecord {
  uri: string;
  cid?: string;
  value: unknown;
}

/**
 * Read one record with com.atproto.repo.getRecord from the repository's
 * own PDS. Returns undefined when the record does not exist.
 */
export async function getRecordFromPds(
  pds: URL,
  repo: string,
  collection: string,
  rkey: string,
  fetcher: typeof fetch = fetch,
): Promise<FetchedRecord | undefined> {
  const url = new URL("/xrpc/com.atproto.repo.getRecord", pds);
  url.searchParams.set("repo", repo);
  url.searchParams.set("collection", collection);
  url.searchParams.set("rkey", rkey);
  const { status, body } = await fetchJson<FetchedRecord>(fetcher, url);
  if (!body) {
    if (status === 400 || status === 404) return undefined;
    throw new Error(`PDS returned ${status}`);
  }
  return body;
}
