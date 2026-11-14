import type { LookupFn } from "../did.js";

export const USER_DID = "did:plc:abcdefghijklmnopqrstuvwx";
export const OTHER_DID = "did:plc:zyxwvutsrqponmlkjihgfedc";
export const SERVICE_DID = "did:plc:croftclickservice2345abc";
export const USER_PDS = "https://pds.example.com";
export const SERVICE_PDS = "https://service-pds.example.com";

export const publicLookup: LookupFn = async () => [
  { address: "93.184.216.34" },
];

type Handler = (
  url: URL,
  init?: RequestInit,
) => Response | Promise<Response> | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that dispatches to handlers and records every call. */
export function mockFetch(...handlers: Handler[]) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    calls.push({ url, init });
    for (const handler of handlers) {
      const response = await handler(url, init);
      if (response) return response;
    }
    return json({ error: "NotFound" }, 404);
  }) as typeof fetch;
  return { fetcher, calls };
}

export function didDoc(did: string, pds: string) {
  return {
    id: did,
    alsoKnownAs: ["at://someone.example.com"],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: pds,
      },
    ],
  };
}

/** PLC directory handler for the given DID → PDS mapping. */
export function plc(entries: Record<string, string>): Handler {
  return (url) => {
    if (url.origin !== "https://plc.directory") return undefined;
    const did = decodeURIComponent(url.pathname.slice(1));
    return entries[did] ? json(didDoc(did, entries[did])) : json({}, 404);
  };
}
