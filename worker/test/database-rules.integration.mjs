import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("database rules allow only counter reads and increments of one", async (t) => {
  const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  assert.match(
    host ?? "",
    /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/,
    "Run this test with firebase emulators:exec --only database --project demo-thankyouindo",
  );
  const base = `http://${host}`;
  const request = (path, method = "GET", value, admin = false) =>
    fetch(`${base}/${path}.json?ns=demo-thankyouindo`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(admin ? { Authorization: "Bearer owner" } : {}),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
      signal: AbortSignal.timeout(5000),
    });
  const rules = JSON.parse(
    await readFile(
      new URL("../../database.rules.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    (await request(".settings/rules", "PUT", rules, true)).status,
    200,
  );
  assert.equal((await request("", "PUT", null, true)).status, 200);
  t.after(async () => {
    assert.equal((await request("", "PUT", null, true)).status, 200);
  });

  assert.equal((await request("incremental_counter")).status, 200);
  assert.equal((await request("")).status, 401, "Root reads must stay private");
  assert.equal((await request("unrelated")).status, 401);
  assert.equal((await request("incremental_counter", "PUT", 0)).status, 401);
  assert.equal((await request("incremental_counter", "PUT", 1)).status, 200);
  const increment = { ".sv": { increment: 1 } };
  assert.equal(
    (await request("incremental_counter", "PUT", increment)).status,
    200,
  );
  assert.equal(await (await request("incremental_counter")).json(), 2);

  assert.equal(
    (await request("incremental_counter", "PUT", 10, true)).status,
    200,
  );
  const writes = await Promise.all(
    Array.from({ length: 10 }, () =>
      request("incremental_counter", "PUT", increment),
    ),
  );
  for (const response of writes) assert.equal(response.status, 200);
  assert.equal(await (await request("incremental_counter")).json(), 20);

  for (const value of [
    null,
    0,
    20,
    22,
    -1,
    20.5,
    "21",
    true,
    {},
    { child: 21 },
  ]) {
    assert.equal(
      (await request("incremental_counter", "PUT", value)).status,
      401,
      `Reject replacing the counter with ${JSON.stringify(value)}`,
    );
  }
  for (const value of [0, 2, -1]) {
    assert.equal(
      (
        await request("incremental_counter", "PUT", {
          ".sv": { increment: value },
        })
      ).status,
      401,
      `Reject a server increment of ${value}`,
    );
  }
  assert.equal((await request("unrelated", "PUT", 1)).status, 401);
  assert.equal(
    (await request("incremental_counter/child", "PUT", 21)).status,
    401,
  );
  assert.equal(
    (await request("", "PUT", { incremental_counter: 21 })).status,
    401,
  );
  assert.equal(await (await request("incremental_counter")).json(), 20);

  assert.equal(
    (await request("incremental_counter", "PUT", null, true)).status,
    200,
  );
  assert.equal(
    (await request("incremental_counter", "PUT", increment)).status,
    200,
  );
  assert.equal(await (await request("incremental_counter")).json(), 1);
});
