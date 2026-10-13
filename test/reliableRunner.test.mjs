// Run independently of a Zotero instance: node --test test/reliableRunner.test.mjs
// Load the actual TypeScript sources with the project's existing compiler.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

function transpile(path, module) {
  return ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), "utf8"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module },
    },
  ).outputText;
}
const lifecycle = await import(
  `data:text/javascript;base64,${Buffer.from(
    transpile("../src/utils/reliableRun.ts", ts.ModuleKind.ES2022),
  ).toString("base64")}`
);
const {
  runReliableTask,
  publishReliableTaskProgress,
  invalidateReliableTask,
  invalidateAllReliableTasks,
  redactServiceError,
  getTranslationTimeoutMs,
} = lifecycle;

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function task(overrides = {}) {
  return {
    id: "test",
    type: "text",
    raw: "A short source sentence.",
    result: "old cached translation",
    audio: [],
    service: "cnki",
    candidateServices: [],
    itemId: undefined,
    langfrom: "en-US",
    langto: "zh-CN",
    status: "waiting",
    extraTasks: [],
    ...overrides,
  };
}
function options(overrides = {}) {
  return {
    timeoutMs: 1000,
    clone: (current) => ({
      ...current,
      audio: current.audio.map((entry) => ({ ...entry })),
      candidateServices: [...current.candidateServices],
    }),
    commit: (current, attempt) => {
      current.result = redactServiceError(attempt.result, attempt.secret);
      current.audio = attempt.audio.map((entry) => ({ ...entry }));
    },
    formatError: (error, attempt) =>
      redactServiceError(String(error), attempt.secret),
    ...overrides,
  };
}

test("concurrent retry commits only the newest response", async () => {
  const data = task();
  const oldResponse = deferred();
  let oldAttempt;
  const first = runReliableTask(
    data,
    async (attempt) => {
      oldAttempt = attempt;
      await oldResponse.promise;
      attempt.result = "late old response";
      attempt.audio.push({ text: "old", url: "old.mp3" });
    },
    options(),
  );
  await Promise.resolve();
  assert.notEqual(oldAttempt, data);
  assert.equal(data.result, "");
  const second = runReliableTask(
    data,
    (attempt) => {
      attempt.result = "new response";
      attempt.audio.push({ text: "new", url: "new.mp3" });
    },
    options(),
  );
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(data.status, "success");
  oldResponse.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(data.result, "new response");
  assert.deepEqual(data.audio, [{ text: "new", url: "new.mp3" }]);
  assert.equal(publishReliableTaskProgress(oldAttempt), false);
});

test("an invocation superseded before its microtask avoids a duplicate request", async () => {
  const data = task();
  let calls = 0;
  const processor = (attempt) => {
    calls++;
    attempt.result = "latest";
  };
  const first = runReliableTask(data, processor, options());
  const second = runReliableTask(data, processor, options());
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(calls, 1);
});

test("stream progress remains processing and late stream cannot overwrite a retry", async () => {
  const data = task();
  const firstResponse = deferred();
  const secondResponse = deferred();
  let firstAttempt, secondAttempt;
  const first = runReliableTask(
    data,
    async (attempt) => {
      firstAttempt = attempt;
      attempt.result = "first partial";
      attempt.status = "success"; // provider's early onload callback
      assert.equal(publishReliableTaskProgress(attempt), true);
      await firstResponse.promise;
    },
    options(),
  );
  await Promise.resolve();
  assert.equal(data.result, "first partial");
  assert.equal(data.status, "processing");
  const second = runReliableTask(
    data,
    async (attempt) => {
      secondAttempt = attempt;
      attempt.result = "second partial";
      assert.equal(publishReliableTaskProgress(attempt), true);
      await secondResponse.promise;
      attempt.result = "second final";
    },
    options(),
  );
  await Promise.resolve();
  firstAttempt.result = "late stream";
  assert.equal(publishReliableTaskProgress(firstAttempt), false);
  assert.equal(data.result, "second partial");
  firstResponse.resolve();
  secondResponse.resolve();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(data.result, "second final");
  secondAttempt.result = "even later onload";
  assert.equal(publishReliableTaskProgress(secondAttempt), false);
  assert.equal(data.result, "second final");
});

test("deadline fails explicitly, and the late response cannot restore success", async () => {
  const data = task();
  const response = deferred();
  let attempt;
  const result = runReliableTask(
    data,
    async (current) => {
      attempt = current;
      await response.promise;
      current.result = "late after deadline";
    },
    options({ timeoutMs: 10 }),
  );
  assert.equal(await result, true);
  assert.equal(data.status, "fail");
  assert.match(data.result, /超时/);
  assert.equal(data.processed, true);
  const timeoutMessage = data.result;
  response.resolve();
  await Promise.resolve();
  assert.equal(publishReliableTaskProgress(attempt), false);
  assert.equal(data.status, "fail");
  assert.equal(data.result, timeoutMessage);
});

test("empty/whitespace and provider fail status cannot be successful", async () => {
  for (const result of ["", " ", "\n\t"]) {
    const data = task();
    assert.equal(
      await runReliableTask(
        data,
        (attempt) => {
          attempt.result = result;
        },
        options(),
      ),
      true,
    );
    assert.equal(data.status, "fail");
    assert.match(data.result, /有效译文/);
  }
  const data = task();
  await runReliableTask(
    data,
    (attempt) => {
      attempt.result = "provider rejected the request";
      attempt.status = "fail";
    },
    options(),
  );
  assert.equal(data.status, "fail");
  assert.match(data.result, /provider rejected/);
});

test("a failed task and an identical successful task can both be retried", async () => {
  const data = task();
  await runReliableTask(
    data,
    () => {
      throw new Error("offline");
    },
    options(),
  );
  assert.equal(data.status, "fail");
  await runReliableTask(
    data,
    (attempt) => {
      attempt.result = "recovered";
    },
    options(),
  );
  assert.equal(data.status, "success");
  assert.equal(data.result, "recovered");
  await runReliableTask(
    data,
    (attempt) => {
      attempt.result = "same text fresh result";
    },
    options(),
  );
  assert.equal(data.result, "same text fresh result");
});

test("superseded rejection is consumed without replacing the active result", async () => {
  const data = task();
  const oldResponse = deferred();
  const first = runReliableTask(data, () => oldResponse.promise, options());
  await Promise.resolve();
  await runReliableTask(
    data,
    (attempt) => {
      attempt.result = "current";
    },
    options(),
  );
  assert.equal(await first, false);
  oldResponse.reject(new Error("late HTTP failure"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(data.result, "current");
  assert.equal(data.status, "success");
});

test("cache invalidation and shutdown immediately stop publishing pending attempts", async () => {
  const data = task();
  const response = deferred();
  let attempt;
  const pending = runReliableTask(
    data,
    async (current) => {
      attempt = current;
      await response.promise;
      current.result = "obsolete";
    },
    options(),
  );
  await Promise.resolve();
  invalidateReliableTask(data);
  data.result = "cached result";
  data.status = "success";
  assert.equal(publishReliableTaskProgress(attempt), false);
  assert.equal(await pending, false);
  assert.equal(data.result, "cached result");
  const other = task({ id: "other" });
  let otherAttempt;
  const otherPending = runReliableTask(
    other,
    async (current) => {
      otherAttempt = current;
      await response.promise;
    },
    options(),
  );
  await Promise.resolve();
  invalidateAllReliableTasks();
  assert.equal(publishReliableTaskProgress(otherAttempt), false);
  assert.equal(await otherPending, false);
  response.resolve();
  assert.equal(publishReliableTaskProgress(task()), true);
});

test("source edits invalidate attempts even without a subsequent invocation", async () => {
  const data = task();
  const originalRaw = data.raw;
  const response = deferred();
  let attempt;
  const pending = runReliableTask(
    data,
    async (current) => {
      attempt = current;
      await response.promise;
      current.result = "translation of old source";
    },
    options({ isTaskUnchanged: () => data.raw === originalRaw }),
  );
  await Promise.resolve();
  data.raw = "Edited source";
  assert.equal(publishReliableTaskProgress(attempt), false);
  response.resolve();
  assert.equal(await pending, false);
  assert.equal(data.result, "");
});

test("composite secrets, URL-encoded values, URLs and headers are redacted", () => {
  const secret = "appid-123#sensitive+key/456#region-789";
  const detail = `failure ${secret} ${encodeURIComponent(secret)} sensitive+key/456 appid-123
    https://example.invalid?secretKey=another-credential&token=unrelated-token
    Authorization: Bearer header-token x-api-key=private-header`;
  const safe = redactServiceError(detail, secret);
  for (const value of [
    secret,
    encodeURIComponent(secret),
    "sensitive+key/456",
    "appid-123",
    "region-789",
    "another-credential",
    "unrelated-token",
    "header-token",
    "private-header",
  ]) {
    assert.equal(safe.includes(value), false, value);
  }
  assert.match(safe, /\[REDACTED\]/);
});

test("word and long CNKI requests have bounded service-aware deadlines", () => {
  const base = { service: "cnki", raw: "x".repeat(100) };
  assert.equal(
    getTranslationTimeoutMs({ ...base, serviceType: "word" }),
    20_000,
  );
  assert.equal(getTranslationTimeoutMs(base), 45_000);
  assert.equal(
    getTranslationTimeoutMs({
      ...base,
      raw: "x".repeat(1600),
      cnkiUseSplit: true,
      cnkiSplitSecond: 2,
    }),
    72_000,
  );
  assert.equal(
    getTranslationTimeoutMs({
      ...base,
      raw: "x".repeat(100_000),
      cnkiUseSplit: true,
    }),
    180_000,
  );
  assert.equal(
    getTranslationTimeoutMs({
      ...base,
      raw: "x".repeat(1600),
      cnkiUseSplit: true,
      cnkiSplitSecond: Number.NaN,
    }),
    70_000,
  );
});

test("standalone tokens, Basic auth, JSON credentials and URL userinfo are hidden", () => {
  const secret = JSON.stringify({
    nested: { key: "json-private-value" },
    short: "xyz",
  });
  const detail =
    'Token: opaque-token {"token":"quoted token with spaces"} ' +
    "Authorization: Basic ZmFrZS11c2VyOnBhc3N3b3Jk " +
    "https://private-user:private-password@example.invalid/path " +
    'failure json-private-value xyz {"password":"quoted password with spaces"}';
  const safe = redactServiceError(detail, secret);
  for (const value of [
    "opaque-token",
    "quoted token with spaces",
    "ZmFrZS11c2VyOnBhc3N3b3Jk",
    "private-user",
    "private-password",
    "json-private-value",
    "xyz",
    "quoted password with spaces",
  ]) {
    assert.equal(safe.includes(value), false, value);
  }
});

test("redaction accepts lower-case URI escapes and malformed credential Unicode", () => {
  const secret = "synthetic+key/value";
  const encoded = encodeURIComponent(secret).replace(/%[A-F0-9]{2}/g, (s) =>
    s.toLowerCase(),
  );
  assert.equal(
    redactServiceError(`failure ${encoded}`, secret).includes(encoded),
    false,
  );
  const malformed = "synthetic-\uD800";
  assert.equal(
    redactServiceError(`failure ${malformed}`, malformed).includes(malformed),
    false,
  );
});

test("an error formatter failure still commits a safe failure status", async () => {
  const data = task();
  await runReliableTask(
    data,
    () => {
      throw new Error("synthetic provider error");
    },
    options({
      formatError: () => {
        throw new Error("synthetic sensitive detail");
      },
    }),
  );
  assert.equal(data.status, "fail");
  assert.match(data.result, /错误信息无法解析/);
  assert.equal(data.result.includes("synthetic sensitive detail"), false);
});

// Real TranslateTaskRunner integration with a minimal Zotero fixture, so the
// production wrapper's cloning, log/error sanitization and placeholders are
// covered too, without contacting a service or reading any user preferences.
function loadTaskRunner(item = null) {
  const logs = [];
  const config = { addonInstance: "FixtureTranslate", addonID: "fixture@test" };
  const addon = {
    data: {
      ztoolkit: { log: (...args) => logs.push(args) },
      translate: {
        services: { getServiceById: () => ({ type: "sentence" }) },
        queue: [],
        maximumQueueLength: 100,
        concatCheckbox: false,
      },
      panel: { windowPanel: null },
    },
  };
  const module = { exports: {} };
  const imports = {
    "./config": {
      inferLanguage: () => ({ code: "en-US" }),
      matchLanguage: () => ({ code: "" }),
    },
    "./locale": {
      getString: (key) => (key === "status-translating" ? "Translating" : key),
    },
    "./prefs": {
      getPref: (key) =>
        ({
          sourceLanguage: "en-US",
          targetLanguage: "zh-CN",
          enableAutoDetectLanguage: true,
          cnkiUseSplit: false,
          cnkiSplitSecond: 1,
        })[key],
    },
    "./secret": {
      getServiceSecret: () => "fixture-account#fixture-sensitive-key",
    },
    "../../package.json": { config },
    "../addon": {},
    "./reliableRun": lifecycle,
  };
  new Script(
    transpile("../src/utils/task.ts", ts.ModuleKind.CommonJS),
  ).runInNewContext({
    module,
    exports: module.exports,
    require: (id) => {
      assert.ok(Object.hasOwn(imports, id), `Unexpected import ${id}`);
      return imports[id];
    },
    Zotero: {
      [config.addonInstance]: addon,
      Items: { get: () => item, getTopLevel: () => [item] },
      Utilities: { randomString: () => "synthetic-id" },
    },
    addon,
    Intl,
    Error,
    console,
  });
  return { ...module.exports, logs, addon };
}
const integration = loadTaskRunner();

test("actual runner keeps provider credentials off the public task and logs", async () => {
  const data = task();
  const runner = new integration.TranslateTaskRunner((attempt) => {
    assert.equal(attempt.secret, "fixture-account#fixture-sensitive-key");
    assert.notEqual(attempt, data);
    throw new Error(`HTTP Authorization: Bearer ${attempt.secret}`);
  });
  assert.equal(await runner.run(data), true);
  assert.equal(data.status, "fail");
  assert.equal(Object.hasOwn(data, "secret"), false);
  assert.equal(data.result.includes("fixture-sensitive-key"), false);
  const logged = JSON.stringify(integration.logs);
  assert.equal(logged.includes("fixture-sensitive-key"), false);
  assert.equal(logged.includes("fixture-account"), false);
});

test("actual runner rejects placeholder responses and preserves full source for retry", async () => {
  const data = task();
  const first = new integration.TranslateTaskRunner((attempt) => {
    attempt.raw = attempt.raw.slice(0, 3);
    attempt.result = "Translating";
  });
  const source = data.raw;
  await first.run(data);
  assert.equal(data.status, "fail");
  assert.equal(data.raw, source);
  const second = new integration.TranslateTaskRunner((attempt) => {
    assert.equal(attempt.raw, source);
    attempt.result = "完整译文";
  });
  await second.run(data);
  assert.equal(data.status, "success");
  assert.equal(data.result, "完整译文");
});

test("an explicit retry service creates an independent task even with concatenation enabled", () => {
  const fixture = loadTaskRunner();
  const original = task({ id: "original", raw: "previous passage" });
  fixture.addon.data.translate.queue.push(original);
  fixture.addon.data.translate.concatCheckbox = true;
  const independent = fixture.addTranslateTask(
    "retry passage",
    7,
    "text",
    "cnki",
  );
  assert.notEqual(independent, original);
  assert.equal(independent.service, "cnki");
  assert.equal(independent.raw, "retry passage");
  assert.equal(original.raw, "previous passage");
  fixture.addTranslateTask("appended passage", 7, "text");
  assert.equal(independent.raw, "retry passage appended passage");
  assert.equal(fixture.addon.data.translate.queue.length, 2);
});

test("language inference reads bibliography without changing its language field", () => {
  const reads = [];
  const item = {
    id: 7,
    getField: (name) => {
      reads.push(name);
      return name === "title" ? "synthetic English title" : "";
    },
    setField: () => {
      assert.fail("language inference must not modify item metadata");
    },
    saveTx: () => {
      assert.fail("language inference must not save item metadata");
    },
  };
  const fixture = loadTaskRunner(item);
  fixture.addon.data.translate.cachedSourceLanguage = {};
  const languages = fixture.autoDetectLanguage(item);
  assert.equal(languages.fromLanguage, "en-US");
  assert.ok(reads.includes("language"));
  assert.ok(reads.includes("title"));
});

test("logged audio URLs redact credentials while leaving the runtime task intact", () => {
  const data = task({
    secret: "synthetic-private-key",
    audio: [
      {
        text: "sound",
        url: "https://example.invalid/speech?token=synthetic-private-key",
      },
    ],
  });
  const snapshot = integration.sanitizeTaskForLog(data);
  assert.equal(snapshot.secret, "[REDACTED]");
  assert.equal(
    JSON.stringify(snapshot).includes("synthetic-private-key"),
    false,
  );
  assert.ok(data.audio[0].url.includes("synthetic-private-key"));
});
