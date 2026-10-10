import test from "node:test";
import assert from "node:assert/strict";
import {
  createTurnstileProvider,
  TURNSTILE_ACTION,
  TURNSTILE_SITE_KEY,
} from "../../public/turnstile-app-check.js";

function widget() {
  const state = { resets: [], executions: [] };
  return {
    state,
    render(container, options) {
      state.options = options;
      return "widget-1";
    },
    execute(id) {
      state.executions.push(id);
    },
    reset(id) {
      state.resets.push(id);
    },
  };
}
const endpoint = "https://worker.example/api/app-check";
const verified = () =>
  Response.json({
    token: "app-check-token",
    expireTimeMillis: Date.now() + 1800000,
  });

test("concurrent SDK requests share one challenge; the next exchange uses a fresh token", async () => {
  const turnstile = widget();
  const requests = [];
  const provider = createTurnstileProvider(turnstile, "#widget", {
    endpoint,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return verified();
    },
  });
  const first = provider.getToken();
  assert.equal(provider.getToken(), first);
  await Promise.resolve();
  assert.equal(requests.length, 0);
  assert.equal(turnstile.state.options.sitekey, TURNSTILE_SITE_KEY);
  assert.equal(turnstile.state.options.action, TURNSTILE_ACTION);
  turnstile.state.options.callback("first-turnstile-token");
  await first;
  assert.equal(requests[0].url, endpoint);
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(
    JSON.parse(requests[0].options.body)["cf-turnstile-response"],
    "first-turnstile-token",
  );
  assert.deepEqual(turnstile.state.resets, ["widget-1"]);

  const second = provider.getToken();
  await Promise.resolve();
  turnstile.state.options.callback("second-turnstile-token");
  await second;
  assert.equal(
    JSON.parse(requests[1].options.body)["cf-turnstile-response"],
    "second-turnstile-token",
  );
  assert.deepEqual(turnstile.state.executions, ["widget-1", "widget-1"]);
  assert.deepEqual(turnstile.state.resets, ["widget-1", "widget-1"]);
});

test("a rejected exchange resets the widget and allows a new challenge", async () => {
  const turnstile = widget();
  let attempts = 0;
  const statuses = [];
  const provider = createTurnstileProvider(turnstile, "#widget", {
    endpoint,
    onStatus: (state) => statuses.push(state),
    fetchImpl: async () =>
      ++attempts === 1 ? new Response(null, { status: 403 }) : verified(),
  });
  const first = provider.getToken();
  await Promise.resolve();
  turnstile.state.options.callback("used-token");
  await assert.rejects(first, /try again/i);
  const second = provider.getToken();
  await Promise.resolve();
  turnstile.state.options.callback("fresh-token");
  assert.equal((await second).token, "app-check-token");
  assert.deepEqual(statuses, ["verifying", "error", "verifying", "verified"]);
  assert.equal(turnstile.state.resets.length, 2);
});

for (const callback of [
  "error-callback",
  "expired-callback",
  "timeout-callback",
]) {
  test(`${callback} rejects without sending a request and resets only its own widget`, async () => {
    const turnstile = widget();
    let requested = false;
    const provider = createTurnstileProvider(turnstile, "#widget", {
      endpoint,
      fetchImpl: async () => {
        requested = true;
        return verified();
      },
    });
    const pending = provider.getToken();
    await Promise.resolve();
    turnstile.state.options[callback]();
    await assert.rejects(pending);
    assert.equal(requested, false);
    assert.deepEqual(turnstile.state.resets, ["widget-1"]);
  });
}

test("challenge timeout and synchronous execution failure allow retry", async () => {
  for (const failure of ["timeout", "execution"]) {
    const turnstile = widget();
    if (failure === "execution")
      turnstile.execute = () => {
        throw new Error("widget unavailable");
      };
    const provider = createTurnstileProvider(turnstile, "#widget", {
      endpoint,
      timeoutMillis: 5,
    });
    await assert.rejects(provider.getToken());
    await assert.rejects(provider.getToken());
    assert.equal(turnstile.state.resets.length, 2);
  }
});

test("malformed or expired App Check responses cannot mark the visit verified", async () => {
  for (const response of [
    { token: "x", expireTimeMillis: 0 },
    { token: "", expireTimeMillis: Date.now() + 1800000 },
  ]) {
    const turnstile = widget();
    const statuses = [];
    const provider = createTurnstileProvider(turnstile, "#widget", {
      endpoint,
      onStatus: (state) => statuses.push(state),
      fetchImpl: async () => Response.json(response),
    });
    const pending = provider.getToken();
    await Promise.resolve();
    turnstile.state.options.callback("turnstile-token");
    await assert.rejects(pending);
    assert.deepEqual(statuses, ["verifying", "error"]);
    assert.deepEqual(turnstile.state.resets, ["widget-1"]);
  }
});
