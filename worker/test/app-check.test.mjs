import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION,
  APP_ID,
  PROJECT_NUMBER,
  SIGNER_EMAIL,
  createHandler,
  mintAppCheckToken,
} from "../src/app-check.mjs";

const hostname = "thankyouindoforthecleanair.web.app";
const origin = `https://${hostname}`;
const env = {
  TURNSTILE_SECRET: "test-secret",
  FIREBASE_SIGNING_KEY: "test-signing-key",
  TURNSTILE_HOSTNAMES: hostname,
  ALLOWED_ORIGINS: origin,
};
const verified = { success: true, action: ACTION, hostname };
function request(token = "fresh-token", options = {}) {
  return new Request("https://worker.example/api/app-check", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ "cf-turnstile-response": token }),
    ...options,
  });
}
function fixture(result = verified) {
  const calls = [];
  let minted = 0;
  const handler = createHandler({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(result);
    },
    mintToken: async () => {
      minted++;
      return {
        token: "app-check-token",
        expireTimeMillis: Date.now() + 1800000,
      };
    },
  });
  return {
    handler,
    calls,
    get minted() {
      return minted;
    },
  };
}

test("verified visits receive a non-cacheable App Check token after canonical Siteverify", async () => {
  const f = fixture();
  const response = await f.handler(request(), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).token, "app-check-token");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(f.minted, 1);
  assert.equal(
    f.calls[0].url,
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  );
  assert.equal(f.calls[0].options.method, "POST");
  assert.equal(f.calls[0].options.body.get("secret"), env.TURNSTILE_SECRET);
  assert.equal(f.calls[0].options.body.get("response"), "fresh-token");
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);
});

for (const [label, result] of [
  ["failed verification", { ...verified, success: false }],
  ["truthy non-boolean success", { ...verified, success: "true" }],
  ["wrong action", { ...verified, action: "another_action" }],
  ["wrong hostname", { ...verified, hostname: "attacker.example" }],
  [
    "expired token",
    { success: false, "error-codes": ["timeout-or-duplicate"] },
  ],
  ["empty result", {}],
  ["null result", null],
]) {
  test(`${label} cannot mint an App Check token`, async () => {
    const f = fixture(result);
    assert.equal((await f.handler(request(), env)).status, 403);
    assert.equal(f.minted, 0);
  });
}

for (const token of [undefined, null, 7, "", "   ", "x".repeat(2049)]) {
  test(`invalid token (${typeof token}, length ${token?.length ?? 0}) is rejected before Siteverify`, async () => {
    const f = fixture();
    // Override the body so JSON.stringify omits undefined without using request()'s default token.
    const req = request("unused", {
      body: JSON.stringify({ "cf-turnstile-response": token }),
    });
    assert.equal((await f.handler(req, env)).status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal(f.minted, 0);
  });
}

test("a replay rejected by Siteverify cannot mint a second token", async () => {
  let redeemed = false;
  let minted = 0;
  const handler = createHandler({
    fetchImpl: async () => {
      const result =
        redeemed ?
          { success: false, "error-codes": ["timeout-or-duplicate"] }
        : verified;
      redeemed = true;
      return Response.json(result);
    },
    mintToken: async () => {
      minted++;
      return {
        token: "app-check-token",
        expireTimeMillis: Date.now() + 1800000,
      };
    },
  });
  assert.equal((await handler(request("same-token"), env)).status, 200);
  assert.equal((await handler(request("same-token"), env)).status, 403);
  assert.equal(minted, 1);
});

test("unapproved origins, malformed JSON, and oversized streamed bodies never reach Siteverify", async () => {
  for (const req of [
    request("fresh", {
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
    }),
    request("fresh", { body: "{" }),
    request("fresh", { body: JSON.stringify({ padding: "x".repeat(4096) }) }),
    request("fresh", {
      headers: { Origin: origin, "Content-Type": "text/plain" },
    }),
  ]) {
    const f = fixture();
    assert.equal((await f.handler(req, env)).status, 403);
    assert.equal(f.calls.length, 0);
  }
});

test("production refuses localhost hostnames and missing secret bindings", async () => {
  for (const overrides of [
    { TURNSTILE_HOSTNAMES: "" },
    { TURNSTILE_HOSTNAMES: `${hostname},localhost` },
    { TURNSTILE_HOSTNAMES: `${hostname},127.0.0.1` },
    { TURNSTILE_SECRET: "" },
    { FIREBASE_SIGNING_KEY: "" },
  ]) {
    const f = fixture();
    assert.equal(
      (await f.handler(request(), { ...env, ...overrides })).status,
      503,
    );
    assert.equal(f.calls.length, 0);
  }
});

test("a token from a different approved site still must match the requesting origin", async () => {
  const f = fixture({
    ...verified,
    hostname: "thankyouindoforthecleanair.firebaseapp.com",
  });
  assert.equal(
    (
      await f.handler(request(), {
        ...env,
        TURNSTILE_HOSTNAMES: `${hostname},thankyouindoforthecleanair.firebaseapp.com`,
      })
    ).status,
    403,
  );
  assert.equal(f.minted, 0);
});

test("upstream network, HTTP, and JSON failures fail closed", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error("timeout");
    },
    async () => new Response("unavailable", { status: 500 }),
    async () => new Response("not-json"),
  ]) {
    let minted = false;
    const handler = createHandler({
      fetchImpl,
      mintToken: async () => {
        minted = true;
      },
    });
    assert.equal((await handler(request(), env)).status, 403);
    assert.equal(minted, false);
  }
});

test("minting failures do not expose signing material", async () => {
  const handler = createHandler({
    fetchImpl: async () => Response.json(verified),
    mintToken: async () => {
      throw new Error(env.FIREBASE_SIGNING_KEY);
    },
  });
  const response = await handler(request(), env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"verification_unavailable"}');
});

test("only the configured route accepts POST, with origin-specific CORS preflight", async () => {
  const f = fixture();
  const get = new Request("https://worker.example/api/app-check", {
    headers: { Origin: origin },
  });
  assert.equal((await f.handler(get, env)).status, 405);
  assert.equal(
    (await f.handler(new Request("https://worker.example/"), env)).status,
    404,
  );
  const preflight = await f.handler(
    new Request("https://worker.example/api/app-check", {
      method: "OPTIONS",
      headers: { Origin: origin },
    }),
    env,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(f.calls.length, 0);
});

test("Firebase custom token has a valid RSA signature, a fixed app ID, and a 30-minute TTL", async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----`;
  const now = 1800000000000;
  let customToken;
  const result = await mintAppCheckToken(
    { FIREBASE_SIGNING_KEY: pem },
    async (url, options) => {
      assert.ok(
        url.includes(
          `/projects/${PROJECT_NUMBER}/apps/${APP_ID}:exchangeCustomToken`,
        ),
      );
      customToken = JSON.parse(options.body).customToken;
      return Response.json({ token: "issued-token", ttl: "1800s" });
    },
    () => now,
  );
  const [header, payload, signature] = customToken.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.app_id, APP_ID);
  assert.equal(claims.iss, SIGNER_EMAIL);
  assert.equal(claims.sub, SIGNER_EMAIL);
  assert.equal(claims.ttl, "1800s");
  assert.equal(claims.exp - claims.iat, 300);
  assert.ok(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keys.publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  assert.deepEqual(result, {
    token: "issued-token",
    expireTimeMillis: now + 1800000,
  });
});
