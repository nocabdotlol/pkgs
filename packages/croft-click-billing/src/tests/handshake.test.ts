import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPublicHttpsOrigin,
  isAtprotoDid,
  isPrivateAddress,
} from "../did.js";
import {
  completeHandshake,
  HANDSHAKE_COLLECTION,
  HandshakeError,
  issueChallenge,
  type HandshakeOptions,
} from "../handshake.js";
import { MemoryStore } from "../store.js";
import {
  json,
  mockFetch,
  plc,
  publicLookup,
  SERVICE_DID,
  USER_DID,
  USER_PDS,
} from "./helpers.js";

const T0 = new Date("2026-11-14T12:00:00Z");

/** A fake user PDS that holds whatever records the "browser" writes. */
function setup(now = T0) {
  const store = new MemoryStore();
  const repo = new Map<string, unknown>();
  const { fetcher, calls } = mockFetch(plc({ [USER_DID]: USER_PDS }), (url) => {
    if (
      url.origin !== USER_PDS ||
      url.pathname !== "/xrpc/com.atproto.repo.getRecord"
    ) {
      return undefined;
    }
    const key = `${url.searchParams.get("repo")}/${url.searchParams.get("collection")}/${url.searchParams.get("rkey")}`;
    const value = repo.get(key);
    return value
      ? json({ uri: `at://${key}`, cid: "bafy", value })
      : json({ error: "RecordNotFound" }, 400);
  });
  let clock = now;
  const options: HandshakeOptions = {
    serviceDid: SERVICE_DID,
    store,
    fetch: fetcher,
    lookup: publicLookup,
    now: () => clock,
  };
  return {
    store,
    repo,
    calls,
    options,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    write: (did: string, rkey: string, value: unknown) =>
      repo.set(`${did}/${HANDSHAKE_COLLECTION}/${rkey}`, value),
  };
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: HandshakeError["code"],
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HandshakeError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

describe("DID helpers", () => {
  it("accepts only did:plc and hostname did:web", () => {
    assert.ok(isAtprotoDid(USER_DID));
    assert.ok(isAtprotoDid("did:web:example.com"));
    assert.ok(!isAtprotoDid("did:web:example.com:path"));
    assert.ok(!isAtprotoDid("did:plc:short"));
    assert.ok(!isAtprotoDid("alice.bsky.social"));
    assert.ok(!isAtprotoDid(undefined));
  });

  it("rejects private and non-HTTPS endpoints", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      "100.64.0.1",
    ]) {
      assert.ok(isPrivateAddress(address), address);
    }
    assert.ok(!isPrivateAddress("93.184.216.34"));
    await assert.rejects(
      assertPublicHttpsOrigin("http://pds.example.com/", publicLookup),
    );
    await assert.rejects(
      assertPublicHttpsOrigin("https://pds.example.com:8443/", publicLookup),
    );
    await assert.rejects(
      assertPublicHttpsOrigin("https://localhost/", publicLookup),
    );
    await assert.rejects(
      assertPublicHttpsOrigin("https://internal.example.com/", async () => [
        { address: "10.0.0.5" },
      ]),
    );
    const ok = await assertPublicHttpsOrigin(
      "https://pds.example.com/",
      publicLookup,
    );
    assert.equal(ok.origin, "https://pds.example.com");
  });
});

describe("handshake", () => {
  it("proves control when the user writes the challenge record", async () => {
    const t = setup();
    const challenge = await issueChallenge(USER_DID, t.options);
    assert.equal(challenge.record.service, SERVICE_DID);
    assert.match(challenge.rkey, /^[A-Za-z0-9_-]{22}$/);
    t.write(USER_DID, challenge.rkey, {
      ...challenge.record,
      createdAt: T0.toISOString(),
    });

    const result = await completeHandshake(
      challenge.rkey,
      challenge.secret,
      t.options,
    );
    assert.deepEqual(result, { did: USER_DID });

    const read = t.calls.find((c) => c.url.pathname.endsWith("getRecord"));
    assert.equal(
      read?.url.origin,
      USER_PDS,
      "reads from the PDS in the DID document",
    );
  });

  it("is single-use, so a copied record cannot be replayed", async () => {
    const t = setup();
    const challenge = await issueChallenge(USER_DID, t.options);
    t.write(USER_DID, challenge.rkey, {
      ...challenge.record,
      createdAt: T0.toISOString(),
    });
    await completeHandshake(challenge.rkey, challenge.secret, t.options);
    await rejectsWith(
      completeHandshake(challenge.rkey, challenge.secret, t.options),
      "unknown_challenge",
    );
  });

  it("requires the browser-held secret, not just the public nonce", async () => {
    const t = setup();
    const challenge = await issueChallenge(USER_DID, t.options);
    t.write(USER_DID, challenge.rkey, {
      ...challenge.record,
      createdAt: T0.toISOString(),
    });
    await rejectsWith(
      completeHandshake(challenge.rkey, "observer-guess", t.options),
      "bad_secret",
    );
    // The real user can still finish afterwards.
    assert.deepEqual(
      await completeHandshake(challenge.rkey, challenge.secret, t.options),
      {
        did: USER_DID,
      },
    );
  });

  it("keeps the challenge open while the record has not appeared yet", async () => {
    const t = setup();
    const challenge = await issueChallenge(USER_DID, t.options);
    await rejectsWith(
      completeHandshake(challenge.rkey, challenge.secret, t.options),
      "record_missing",
    );
    t.write(USER_DID, challenge.rkey, {
      ...challenge.record,
      createdAt: T0.toISOString(),
    });
    assert.deepEqual(
      await completeHandshake(challenge.rkey, challenge.secret, t.options),
      {
        did: USER_DID,
      },
    );
  });

  it("expires", async () => {
    const t = setup();
    const challenge = await issueChallenge(USER_DID, t.options);
    t.write(USER_DID, challenge.rkey, {
      ...challenge.record,
      createdAt: T0.toISOString(),
    });
    t.advance(11 * 60 * 1000);
    await rejectsWith(
      completeHandshake(challenge.rkey, challenge.secret, t.options),
      "expired",
    );
  });

  for (const [name, mutate] of [
    [
      "another service",
      (r: Record<string, unknown>) => ({
        ...r,
        service: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ],
    [
      "a wrong nonce",
      (r: Record<string, unknown>) => ({ ...r, nonce: "x".repeat(43) }),
    ],
    [
      "a wrong type",
      (r: Record<string, unknown>) => ({ ...r, $type: "app.bsky.feed.post" }),
    ],
    [
      "a backdated createdAt",
      (r: Record<string, unknown>) => ({
        ...r,
        createdAt: "2026-11-01T00:00:00Z",
      }),
    ],
    [
      "an extended expiry",
      (r: Record<string, unknown>) => ({
        ...r,
        expiresAt: "2027-01-01T00:00:00Z",
      }),
    ],
  ] as const) {
    it(`rejects a record bound to ${name} and burns the challenge`, async () => {
      const t = setup();
      const challenge = await issueChallenge(USER_DID, t.options);
      t.write(
        USER_DID,
        challenge.rkey,
        mutate({ ...challenge.record, createdAt: T0.toISOString() }),
      );
      await rejectsWith(
        completeHandshake(challenge.rkey, challenge.secret, t.options),
        "record_invalid",
      );
      await rejectsWith(
        completeHandshake(challenge.rkey, challenge.secret, t.options),
        "unknown_challenge",
      );
    });
  }

  it("rejects handles and malformed DIDs up front", async () => {
    const t = setup();
    await rejectsWith(
      issueChallenge("alice.bsky.social", t.options),
      "invalid_did",
    );
  });

  it("does not accept a record from another DID's repository", async () => {
    const t = setup();
    const challenge = await issueChallenge(USER_DID, t.options);
    // Written somewhere else entirely: the server only ever looks in USER_DID's repo.
    t.write("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", challenge.rkey, {
      ...challenge.record,
      createdAt: T0.toISOString(),
    });
    await rejectsWith(
      completeHandshake(challenge.rkey, challenge.secret, t.options),
      "record_missing",
    );
  });
});
