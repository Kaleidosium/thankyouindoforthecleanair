import test from "node:test";
import assert from "node:assert/strict";
import { loadTurnstile } from "../../public/turnstile-app-check.js";

function browser(t) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const scripts = [];
  globalThis.window = {};
  globalThis.document = {
    createElement: () => ({
      removed: false,
      remove() {
        this.removed = true;
      },
    }),
    head: { appendChild: (script) => scripts.push(script) },
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  });
  return scripts;
}

test("a stalled Turnstile script times out, is removed, and can be retried", async (t) => {
  const scripts = browser(t);
  let failure;
  const pending = loadTurnstile().catch((error) => {
    failure = error;
  });
  t.mock.timers.tick(20_000);
  await Promise.resolve();
  assert.match(failure?.message || "", /try again/i);
  await pending;
  assert.equal(scripts[0].removed, true);

  const retry = loadTurnstile();
  assert.equal(scripts.length, 2);
  window.turnstile = { render() {} };
  scripts[1].onload();
  assert.equal(await retry, window.turnstile);
  t.mock.timers.tick(20_000);
  assert.equal(scripts[1].removed, false);
});

test("script load errors remove the tag and allow retry", async (t) => {
  const scripts = browser(t);
  const pending = loadTurnstile();
  scripts[0].onerror();
  await assert.rejects(pending, /try again/i);
  assert.equal(scripts[0].removed, true);
  const retry = loadTurnstile();
  window.turnstile = {};
  scripts[1].onload();
  assert.equal(await retry, window.turnstile);
});

test("an initialized Turnstile API is reused without adding a script", async (t) => {
  const scripts = browser(t);
  window.turnstile = {};
  assert.equal(await loadTurnstile(), window.turnstile);
  assert.equal(scripts.length, 0);
});
