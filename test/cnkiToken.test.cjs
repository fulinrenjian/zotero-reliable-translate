// Pure token lifecycle tests. HTTP and preferences are synthetic in-memory callbacks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(relative, globals = {}, imports = {}) {
  const code = ts.transpileModule(
    readFileSync(resolve(__dirname, "..", relative), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id) => {
      assert.ok(Object.hasOwn(imports, id), `Unexpected dependency ${id}`);
      return imports[id];
    },
    ...globals,
  });
  return module.exports;
}
const utility = load("src/modules/services/cnkiToken.ts");

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function cacheFixture(options = {}) {
  let now = 1000,
    record = options.record;
  const calls = [],
    writes = [];
  const cache = new utility.CnkiTokenCache({
    now: () => now,
    readCache: () => {
      if (options.readFails)
        throw new Error("synthetic sensitive read failure");
      return record;
    },
    writeCache: (value) => {
      if (options.writeFails)
        throw new Error("synthetic sensitive write failure");
      writes.push(value);
      record = value;
    },
    request: async () => {
      calls.push("GET");
      return options.request
        ? options.request(calls.length)
        : `synthetic-token-${calls.length}`;
    },
  });
  return { cache, calls, writes, setTime: (value) => (now = value) };
}

test("concurrent normal and forced token callers share exactly one GET and Promise", async () => {
  const response = deferred(),
    f = cacheFixture({ request: () => response.promise });
  const first = f.cache.get(),
    second = f.cache.get(),
    forced = f.cache.get(true);
  assert.equal(first, second);
  assert.equal(first, forced);
  await tick();
  assert.equal(f.calls.length, 1);
  response.resolve("synthetic-fresh-token");
  assert.equal(await first, "synthetic-fresh-token");
  assert.equal(await second, "synthetic-fresh-token");
  assert.equal(f.writes.length, 1);
});

test("cached prefs are bounded at five minutes and expire exactly at the TTL", async () => {
  const f = cacheFixture({
    record: { token: "synthetic-cached-token", t: 1000 },
  });
  f.setTime(300999);
  assert.equal(await f.cache.get(), "synthetic-cached-token");
  assert.equal(f.calls.length, 0);
  f.setTime(301000);
  assert.equal(await f.cache.get(), "synthetic-token-1");
  assert.equal(f.calls.length, 1);
});

test("future, malformed and nonfinite timestamp records never skip initialization", async () => {
  for (const record of [
    { token: "old", t: 1001 },
    { token: "old", t: "1000" },
    { token: "old", t: NaN },
    { token: "old", t: Infinity },
    { token: " ", t: 1000 },
  ]) {
    const f = cacheFixture({ record });
    await f.cache.get();
    assert.equal(f.calls.length, 1);
  }
});

test("401 refresh is shared and a late rejection of an older token reuses the new token", async () => {
  const response = deferred(),
    f = cacheFixture({
      record: { token: "synthetic-old-token", t: 1000 },
      request: () => response.promise,
    });
  const refresh = f.cache.get(true, "synthetic-old-token"),
    normal = f.cache.get(),
    other = f.cache.get(true, "synthetic-old-token");
  assert.equal(refresh, normal);
  assert.equal(refresh, other);
  await tick();
  assert.equal(f.calls.length, 1);
  response.resolve("synthetic-new-token");
  await refresh;
  assert.equal(
    await f.cache.get(true, "synthetic-old-token"),
    "synthetic-new-token",
  );
  assert.equal(f.calls.length, 1, "late 401 must not cause another GET");
});

test("a failed GET is not retried automatically, while an explicit next request can recover", async () => {
  const f = cacheFixture({
    request: (count) =>
      count === 1
        ? Promise.reject(new Error("synthetic offline"))
        : "synthetic-recovered-token",
  });
  await assert.rejects(f.cache.get(), /offline/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(await f.cache.get(), "synthetic-recovered-token");
  assert.equal(f.calls.length, 2);
});

test("cancellation before a GET starts prevents transport work", async () => {
  const f = cacheFixture(),
    pending = f.cache.get();
  f.cache.cancelPending();
  await assert.rejects(
    pending,
    (error) => error.name === "CnkiTokenCancelledError",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test("cancelled GET completion cannot persist a late token or overwrite newer work", async () => {
  const old = deferred(),
    f = cacheFixture({
      request: (count) =>
        count === 1 ? old.promise : "synthetic-current-token",
    });
  const pending = f.cache.get();
  await tick();
  f.cache.cancelPending();
  await assert.rejects(
    pending,
    (error) => error.name === "CnkiTokenCancelledError",
  );
  assert.equal(await f.cache.get(), "synthetic-current-token");
  old.resolve("synthetic-late-token");
  await tick();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].token, "synthetic-current-token");
});

test("late cancelled rejection is consumed and unavailable prefs use the same bounded memory TTL", async () => {
  const old = deferred(),
    cancelled = cacheFixture({ request: () => old.promise });
  const pending = cancelled.cache.get();
  await tick();
  cancelled.cache.cancelPending();
  await assert.rejects(
    pending,
    (error) => error.name === "CnkiTokenCancelledError",
  );
  old.reject(new Error("synthetic late failure"));
  await tick();
  const memory = cacheFixture({ readFails: true, writeFails: true });
  await memory.cache.get();
  await memory.cache.get();
  assert.equal(memory.calls.length, 1);
  memory.setTime(301000);
  await memory.cache.get();
  assert.equal(memory.calls.length, 2);
});

function serviceFixture(handler, source = "cnki") {
  const calls = [],
    logs = [],
    writes = [];
  let record = {};
  const chunks = load("src/modules/services/cnkiChunks.ts");
  const service = load(
    "src/modules/services/cnki.ts",
    {
      Zotero: {
        HTTP: {
          request: async (method, url, options) => {
            calls.push({ method, url, options });
            return handler(method, calls.length);
          },
        },
      },
      ztoolkit: { log: (...args) => logs.push(args) },
      addon: { api: { getTemporaryRefreshHandler: () => () => {} } },
      setTimeout,
    },
    {
      "./cnkiToken": utility,
      "./cnkiChunks": chunks,
      "../../utils/crypto": {
        aesEcbEncrypt: async (text) => text,
        base64: (value) => value,
      },
      "../../utils/prefs": {
        getPref: (key) =>
          ({
            translateSource: source,
            cnkiUseSplit: true,
            cnkiSplitSecond: 0,
            cnkiRegex: "^$",
          })[key],
        getPrefJSON: () => record,
        setPref: (key, value) => {
          assert.equal(key, "cnkiToken");
          record = JSON.parse(value);
          writes.push(record);
        },
      },
      "../../utils/task": { publishTranslateTaskProgress: () => true },
    },
  );
  return { service, calls, logs, writes };
}

test("reader prewarm issues only one anonymous GET and never a translation POST", async () => {
  const f = serviceFixture(() => ({
    status: 200,
    response: { code: 200, data: "synthetic-prewarm-token" },
  }));
  const reader = {},
    first = f.service.prewarmCnkiToken(reader),
    again = f.service.prewarmCnkiToken(reader);
  assert.equal(first, again);
  assert.equal(await first, true);
  assert.equal(await f.service.prewarmCnkiToken(reader), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "GET");
  assert.equal(f.calls[0].options.body, undefined);
  assert.equal(f.logs.length, 0);
});

test("other selected providers and a reader closed before the microtask do not prefetch", async () => {
  const other = serviceFixture(() => assert.fail("must not fetch"), "bing");
  assert.equal(await other.service.prewarmCnkiToken({}), false);
  assert.equal(other.calls.length, 0);
  let open = true;
  const closed = serviceFixture(() => assert.fail("must not fetch"));
  const pending = closed.service.prewarmCnkiToken({}, () => open);
  open = false;
  assert.equal(await pending, false);
  assert.equal(closed.calls.length, 0);
});

test("failed reader prewarm is not retried by repeated toolbar rendering", async () => {
  const f = serviceFixture(() => {
      throw new Error("synthetic private failure");
    }),
    reader = {};
  assert.equal(await f.service.prewarmCnkiToken(reader), false);
  assert.equal(await f.service.prewarmCnkiToken(reader), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.logs.length, 0);
});

test("closing one reader preserves shared prewarm for another; shutdown rejects late persistence", async () => {
  const response = deferred(),
    f = serviceFixture(() => response.promise);
  let open = true;
  const a = f.service.prewarmCnkiToken({}, () => open),
    b = f.service.prewarmCnkiToken({});
  await tick();
  open = false;
  response.resolve({
    status: 200,
    response: { code: 200, data: "synthetic-shared-token" },
  });
  assert.equal(await a, false);
  assert.equal(await b, true);
  assert.equal(f.calls.length, 1);
  const late = deferred(),
    closed = serviceFixture(() => late.promise);
  const warming = closed.service.prewarmCnkiToken({});
  await tick();
  closed.service.cancelCnkiTokenWork();
  assert.equal(await warming, false);
  late.resolve({
    status: 200,
    response: { code: 200, data: "synthetic-obsolete-token" },
  });
  await tick();
  assert.equal(closed.writes.length, 0);
  assert.equal(closed.logs.length, 0);
});
