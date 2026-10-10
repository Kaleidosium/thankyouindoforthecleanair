export const APP_ID = "1:202426334002:web:94db24c6ca4e633b10b52b";
export const PROJECT_NUMBER = "202426334002";
export const SIGNER_EMAIL =
  "turnstile-app-check@thankyouindoforthecleanair.iam.gserviceaccount.com";
export const ACTION = "firebase_app_check";
const FIREBASE_API_KEY = "AIzaSyA1hciiiNxGqnf8OGfOn_706-A7XEyWpyg";
const TOKEN_TTL_SECONDS = 1800;
const MAX_BODY_BYTES = 4096;
const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function encodeJson(value) {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function mintAppCheckToken(
  env,
  fetchImpl = fetch,
  now = Date.now,
) {
  const pem = env.FIREBASE_SIGNING_KEY;
  const encoded = pem.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    "",
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const issuedAt = now();
  const iat = Math.floor(issuedAt / 1000);
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iss: SIGNER_EMAIL,
    sub: SIGNER_EMAIL,
    app_id: APP_ID,
    aud: "https://firebaseappcheck.googleapis.com/google.firebase.appcheck.v1.TokenExchangeService",
    iat,
    exp: iat + 300,
    ttl: `${TOKEN_TTL_SECONDS}s`,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const response = await fetchImpl(
    `https://firebaseappcheck.googleapis.com/v1/projects/${PROJECT_NUMBER}/apps/${APP_ID}:exchangeCustomToken?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        customToken: `${unsigned}.${base64url(new Uint8Array(signature))}`,
      }),
    },
  );
  if (!response.ok) throw new Error("App Check exchange unavailable");
  const result = await response.json();
  if (
    typeof result.token !== "string" ||
    !result.token ||
    !/^\d+(?:\.\d+)?s$/.test(result.ttl)
  ) {
    throw new Error("Invalid App Check exchange response");
  }
  const ttlMillis = Number(result.ttl.slice(0, -1)) * 1000;
  if (ttlMillis <= 0 || ttlMillis > TOKEN_TTL_SECONDS * 1000) {
    throw new Error("Invalid App Check token lifetime");
  }
  return { token: result.token, expireTimeMillis: issuedAt + ttlMillis };
}

async function readJson(request) {
  if (
    Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES ||
    !request.body
  ) {
    throw new Error("Invalid request size");
  }
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Invalid request size");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createHandler({
  fetchImpl = fetch,
  mintToken = mintAppCheckToken,
} = {}) {
  return async (request, env) => {
    const headers = { "Cache-Control": "no-store", Vary: "Origin" };
    const reply = (status, body) => Response.json(body, { status, headers });
    if (new URL(request.url).pathname !== "/api/app-check") {
      return reply(404, { error: "not_found" });
    }
    const origins = new Set(
      (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const origin = request.headers.get("Origin");
    if (!origins.has(origin))
      return reply(403, { error: "verification_failed" });
    headers["Access-Control-Allow-Origin"] = origin;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (request.method !== "POST") {
      headers.Allow = "POST, OPTIONS";
      return reply(405, { error: "method_not_allowed" });
    }

    const hostnames = new Set(
      (env.TURNSTILE_HOSTNAMES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (
      !env.TURNSTILE_SECRET ||
      !env.FIREBASE_SIGNING_KEY ||
      hostnames.size === 0 ||
      ["localhost", "127.0.0.1", "::1"].some((hostname) =>
        hostnames.has(hostname),
      )
    ) {
      return reply(503, { error: "verification_unavailable" });
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("Content-Type") ?? "",
      )
    ) {
      return reply(403, { error: "verification_failed" });
    }
    let token;
    try {
      token = (await readJson(request))?.["cf-turnstile-response"];
    } catch {
      return reply(403, { error: "verification_failed" });
    }
    if (typeof token !== "string" || !token.trim() || token.length > 2048) {
      return reply(403, { error: "verification_failed" });
    }

    let result;
    try {
      const verification = await fetchImpl(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: token,
        }),
      });
      if (!verification.ok) throw new Error("siteverify unavailable");
      result = await verification.json();
    } catch {
      return reply(403, { error: "verification_failed" });
    }
    if (
      result?.success !== true ||
      result.action !== ACTION ||
      !hostnames.has(result.hostname) ||
      new URL(origin).hostname !== result.hostname
    ) {
      return reply(403, { error: "verification_failed" });
    }
    try {
      return reply(200, await mintToken(env, fetchImpl));
    } catch {
      // Do not log requests, signing keys, or either service's tokens.
      return reply(503, { error: "verification_unavailable" });
    }
  };
}
