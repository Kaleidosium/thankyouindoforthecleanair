import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(
  new URL("../../public/index.html", import.meta.url),
  "utf8",
);
const moduleTag = html.match(/<script type="module" src="([^"]+)"><\/script>/);
assert.ok(moduleTag, "The page must load its controller as a module");
const source = (
  await readFile(
    new URL(moduleTag[1], new URL("../../public/index.html", import.meta.url)),
    "utf8",
  )
).replace(/^\s*import\s+[^;]+;$/gm, "");
const flush = () => new Promise(setImmediate);

async function page({
  storage = new Map(),
  locks,
  storageError,
  writeError,
} = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: "",
        disabled: false,
        hidden: false,
        addEventListener(event, listener) {
          this[event] = listener;
        },
      });
    return elements.get(id);
  };
  const window = new EventTarget();
  const state = {
    tokens: [],
    writes: [],
    playback: [],
    quotes: [{ textContent: "" }],
    databaseConnections: 0,
    subscriptions: 0,
    offline: false,
    gesture: false,
  };
  vm.runInNewContext(source, {
    initializeApp: () => ({}),
    loadTurnstile: async () => ({}),
    createTurnstileProvider: (_api, _container, options) => {
      state.onStatus = options.onStatus;
      return {};
    },
    CustomProvider: class {
      constructor(provider) {
        this.provider = provider;
      }
    },
    initializeAppCheck: (_app, options) => {
      state.appCheckOptions = options;
      return {};
    },
    getToken: (_appCheck, forceRefresh) => {
      const token = { ...Promise.withResolvers(), forceRefresh };
      state.tokens.push(token);
      return token.promise;
    },
    getDatabase: () => {
      state.databaseConnections++;
      return {};
    },
    ref: (_database, path) => ({ path }),
    onValue: (reference, receive, cancel) => {
      if (reference.path === ".info/connected") {
        state.receiveConnection = (value) => receive({ val: () => value });
        state.receiveConnection(true);
        return () => {};
      }
      state.subscriptions++;
      state.receiveCounter = (value) => receive({ val: () => value });
      state.cancelCounter = cancel;
      return () => {};
    },
    increment: (value) => ({ ".sv": { increment: value } }),
    set: (reference, value) => {
      const write = { ...Promise.withResolvers(), reference, value };
      state.writes.push(write);
      return write.promise;
    },
    goOffline: () => {
      state.offline = true;
      state.receiveConnection?.(false);
    },
    goOnline: () => {
      state.offline = false;
      state.receiveConnection?.(true);
    },
    document: {
      querySelector: element,
      getElementById: element,
      getElementsByClassName: () => state.quotes,
    },
    localStorage: {
      getItem: (key) => {
        if (storageError) throw new Error("Storage unavailable");
        return storage.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (storageError || writeError) throw new Error("Storage unavailable");
        storage.set(key, String(value));
      },
    },
    window,
    navigator: {
      locks: locks ?? { request: async (_name, update) => update() },
    },
    Audio: class {
      cloneNode() {
        return this;
      }
      play() {
        state.playback.push(state.gesture);
        return state.gesture ?
            Promise.resolve()
          : Promise.reject(new Error("NotAllowedError"));
      }
    },
  });
  await flush();
  return {
    state,
    storage,
    element,
    storageChanged(key = "localCount") {
      const event = new Event("storage");
      event.key = key;
      window.dispatchEvent(event);
    },
    click() {
      state.gesture = true;
      const pending = element("big-red-button").click();
      state.gesture = false;
      return pending;
    },
  };
}

test("a slow counter save starts audio during the click and updates the personal count only after commit", async () => {
  const { state, storage, element, click } = await page();
  state.tokens[0].resolve({ token: "verified" });
  await flush();
  state.receiveCounter(10);

  const save = click();
  assert.deepEqual(state.writes[0].reference, { path: "incremental_counter" });
  assert.deepEqual(state.writes[0].value, { ".sv": { increment: 1 } });
  assert.deepEqual(state.playback, [true]);
  assert.equal(storage.get("localCount"), undefined);
  assert.equal(state.quotes[0].textContent, "");
  assert.equal(element("big-red-button").disabled, true);
  state.writes[0].resolve();
  await save;
  assert.equal(storage.get("localCount"), "1");
  assert.equal(element("timesUserHasThankedIndonesia").textContent, "1");
  assert.notEqual(state.quotes[0].textContent, "");
  assert.equal(element("big-red-button").disabled, false);
});

test("verification and the first counter value are required before a click can save", async () => {
  const { state, element, click } = await page();
  assert.equal(state.databaseConnections, 0);
  assert.equal(element("big-red-button").disabled, true);
  await click();
  assert.equal(state.writes.length, 0);
  assert.equal(state.playback.length, 0);

  state.tokens[0].resolve({ token: "verified" });
  await flush();
  assert.equal(state.databaseConnections, 1);
  assert.equal(state.subscriptions, 1);
  assert.equal(state.appCheckOptions.isTokenAutoRefreshEnabled, true);
  assert.equal(element("big-red-button").disabled, true);
  await click();
  assert.equal(state.writes.length, 0);
  state.receiveCounter(10);
  assert.equal(element("big-red-button").disabled, false);

  const save = click();
  await click();
  assert.equal(state.writes.length, 1);
  state.writes[0].resolve();
  await save;
  state.receiveCounter(11);
  const secondSave = click();
  state.writes[1].resolve();
  await secondSave;
  assert.equal(state.tokens.length, 1);
  assert.equal(state.subscriptions, 1);
});

test("a rejected save preserves the personal count and Retry restores the button", async () => {
  const { state, storage, element, click } = await page();
  state.tokens[0].resolve({ token: "verified" });
  await flush();
  state.receiveCounter(10);
  const save = click();
  state.writes[0].reject(new Error("Network failure"));
  await save;
  assert.equal(storage.get("localCount"), undefined);
  assert.equal(element("timesUserHasThankedIndonesia").textContent, "0");
  assert.equal(state.quotes[0].textContent, "");
  assert.equal(state.offline, true);
  assert.equal(element("big-red-button").disabled, true);
  assert.equal(element("verification-retry").hidden, false);

  const retry = element("verification-retry").click();
  assert.equal(state.tokens[1].forceRefresh, true);
  state.tokens[1].resolve({ token: "fresh" });
  await retry;
  assert.equal(state.offline, false);
  assert.equal(element("big-red-button").disabled, false);
  assert.equal(element("verification-retry").hidden, true);
  assert.equal(state.subscriptions, 1);
  const saved = click();
  state.writes[1].resolve();
  await saved;
  assert.equal(storage.get("localCount"), "1");
});

test("a failed counter subscription is restored on Retry and waits for the new value", async () => {
  const { state, element } = await page();
  state.tokens[0].resolve({ token: "verified" });
  await flush();
  state.receiveCounter(10);
  state.cancelCounter(new Error("Permission denied"));
  assert.equal(state.offline, true);
  assert.equal(element("big-red-button").disabled, true);
  assert.equal(element("verification-retry").hidden, false);
  const retry = element("verification-retry").click();
  state.tokens[1].resolve({ token: "fresh" });
  await retry;
  assert.equal(state.subscriptions, 2);
  assert.equal(state.databaseConnections, 1);
  assert.equal(element("big-red-button").disabled, true);
  state.receiveCounter(12);
  assert.equal(element(".thanks--counter").textContent, "12");
  assert.equal(element("big-red-button").disabled, false);
});

test("failed verification opens no database connection and can be retried", async () => {
  const { state, element } = await page();
  state.tokens[0].reject(new Error("Verification failed"));
  await flush();
  assert.equal(state.databaseConnections, 0);
  assert.equal(element("big-red-button").disabled, true);
  assert.equal(element("verification-retry").hidden, false);
  const retry = element("verification-retry").click();
  state.tokens[1].resolve({ token: "fresh" });
  await retry;
  state.receiveCounter(10);
  assert.equal(state.databaseConnections, 1);
  assert.equal(element("big-red-button").disabled, false);
});

for (const failure of ["storageError", "writeError"]) {
  test(`${failure} keeps successful global saves usable with a session count`, async () => {
    const { state, element, click, storageChanged } = await page({
      storage: new Map([["localCount", "0"]]),
      [failure]: true,
    });
    state.tokens[0].resolve({ token: "verified" });
    await flush();
    state.receiveCounter(10);
    for (let count = 1; count <= 2; count++) {
      const save = click();
      state.writes.at(-1).resolve();
      await save;
      storageChanged();
      assert.equal(
        element("timesUserHasThankedIndonesia").textContent,
        String(count),
      );
      assert.equal(element("verification-retry").hidden, true);
      assert.equal(element("big-red-button").disabled, false);
      assert.equal(state.offline, false);
    }
  });
}

test("automatic token refresh preserves a canceled counter's Retry until it is resubscribed", async () => {
  const { state, element } = await page();
  state.tokens[0].resolve({ token: "verified" });
  await flush();
  state.receiveCounter(10);
  state.cancelCounter(new Error("Permission denied"));
  state.onStatus("verifying");
  state.onStatus("verified");
  assert.equal(element("verification-retry").hidden, false);
  assert.match(element("verification-status").textContent, /didn't load/i);
  assert.equal(element("big-red-button").disabled, true);
  const retry = element("verification-retry").click();
  state.tokens[1].resolve({ token: "fresh" });
  await retry;
  assert.equal(state.subscriptions, 2);
  state.receiveCounter(12);
  assert.equal(element("big-red-button").disabled, false);
  assert.equal(element("verification-retry").hidden, true);
});

test("concurrent clicks in two tabs preserve every personal increment and sync displays", async () => {
  const storage = new Map([["localCount", "10"]]);
  let previous = Promise.resolve();
  const locks = {
    request(name, update) {
      assert.equal(name, "localCount");
      const pending = previous.then(update);
      previous = pending.catch(() => {});
      return pending;
    },
  };
  const tabs = await Promise.all([
    page({ storage, locks }),
    page({ storage, locks }),
  ]);
  for (const tab of tabs) {
    tab.state.tokens[0].resolve({ token: "verified" });
    await flush();
    tab.state.receiveCounter(10);
  }
  const saves = tabs.map((tab) => tab.click());
  for (const tab of tabs) tab.state.writes[0].resolve();
  await Promise.all(saves);
  assert.equal(storage.get("localCount"), "12");
  for (const tab of tabs) {
    tab.storageChanged();
    assert.equal(tab.element("timesUserHasThankedIndonesia").textContent, "12");
  }
});

test("an offline pending save shows its state and cannot queue a second increment", async () => {
  const { state, element, click } = await page();
  state.tokens[0].resolve({ token: "verified" });
  await flush();
  state.receiveCounter(10);
  const save = click();
  assert.equal(element("verification-status").textContent, "Saving...");
  state.receiveConnection(false);
  assert.match(
    element("verification-status").textContent,
    /waiting for a connection/i,
  );
  await click();
  assert.equal(state.writes.length, 1);
  state.receiveConnection(true);
  assert.equal(element("verification-status").textContent, "Saving...");
  state.writes[0].resolve();
  await save;
  assert.equal(
    element("verification-status").textContent,
    "You can thank Indonesia now.",
  );
  state.receiveConnection(false);
  await click();
  assert.equal(state.writes.length, 1);
});

test("invalid stored counts and unavailable Web Locks recover without failing the global save", async () => {
  for (const value of ["NaN", "-2", "1.5", "9007199254740992"]) {
    const { state, storage, element, click } = await page({
      storage: new Map([["localCount", value]]),
      locks: {
        request: async () => {
          throw new Error("Locks unavailable");
        },
      },
    });
    assert.equal(element("timesUserHasThankedIndonesia").textContent, "0");
    state.tokens[0].resolve({ token: "verified" });
    await flush();
    state.receiveCounter(10);
    const save = click();
    state.writes[0].resolve();
    await save;
    assert.equal(storage.get("localCount"), value);
    assert.equal(element("timesUserHasThankedIndonesia").textContent, "1");
    assert.equal(element("verification-retry").hidden, true);
    assert.equal(element("big-red-button").disabled, false);
  }
});
