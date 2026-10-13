import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import {
  CNKI_MAX_TEXT_LENGTH,
  splitCnkiText,
} from "../src/modules/services/cnkiChunks.ts";

function checkRoundTrip(raw, limit = CNKI_MAX_TEXT_LENGTH) {
  const chunks = splitCnkiText(raw, limit);
  assert.equal(chunks.join(""), raw, "must preserve every source character");
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0 && chunk.length <= limit);
    assert.ok(
      !/[\uD800-\uDBFF]$/u.test(chunk),
      "must not cut a surrogate pair",
    );
    assert.ok(
      !/^[\uDC00-\uDFFF]/u.test(chunk),
      "must not cut a surrogate pair",
    );
  }
  return chunks;
}

test("decimal measurements survive long scientific paragraphs unchanged", () => {
  const sentence =
    "The uptake was 6.73 wt% at 77 K and 1.0 bar; pores measured 0.6–0.8 nm. ";
  const raw = sentence.repeat(30) + "Final value: 3.01";
  const chunks = checkRoundTrip(raw);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), raw);
  assert.equal(chunks.join("").match(/6\.73/g).length, 30);
  assert.ok(chunks.every((chunk) => !/6\.$|0\.$/u.test(chunk)));
});

test("chemical formulas and original line breaks are not rewritten", () => {
  const raw =
    "Na2SO3/NaOH removes lignin. H₂ uptake increased!\nKOH:C = 3:1; temperature = 850 °C. ".repeat(
      25,
    );
  checkRoundTrip(raw);
});

test("a single sentence without punctuation or spaces is still bounded and keeps its tail", () => {
  const raw = "A".repeat(2503) + "END";
  const chunks = checkRoundTrip(raw);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [800, 800, 800, 106],
  );
  assert.ok(chunks.at(-1).endsWith("END"));
});

test("question and exclamation marks remain exactly as written", () => {
  const raw =
    "Why did it improve?! Did adsorption change? Yes! No extra punctuation here";
  const chunks = checkRoundTrip(raw, 45);
  assert.equal(chunks[0], "Why did it improve?! Did adsorption change?");
  assert.equal(chunks.join(""), raw);
  assert.ok(chunks.at(-1).endsWith("here"));
});

test("Chinese sentences split at their punctuation without requiring spaces", () => {
  const raw = "吸附容量增加了吗？是的！请保留中科院分区、H₂及原始数据。".repeat(
    40,
  );
  const chunks = checkRoundTrip(raw);
  assert.ok(chunks.length > 1);
  assert.match(chunks[0], /[。！？]$/u);
});

test("emoji at the hard limit remains a complete Unicode character", () => {
  const raw = "A".repeat(799) + "🧪" + "B".repeat(900);
  const chunks = checkRoundTrip(raw);
  assert.equal(chunks[0].length, 799);
  assert.ok(chunks[1].startsWith("🧪"));
});

test("empty, whitespace, exact limit and one character over limit preserve boundaries", () => {
  assert.deepEqual(splitCnkiText(""), []);
  assert.deepEqual(checkRoundTrip(" \n\t "), [" \n\t "]);
  assert.deepEqual(checkRoundTrip("x".repeat(800)), ["x".repeat(800)]);
  assert.deepEqual(checkRoundTrip("x".repeat(801)), ["x".repeat(800), "x"]);
  assert.deepEqual(checkRoundTrip("abc", 1), ["a", "b", "c"]);
  assert.throws(() => splitCnkiText("🧪", 1), /Unicode character/);
  for (const limit of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitCnkiText("text", limit), /positive integer/);
  }
});

test("mixed paragraphs of varied lengths always round trip with bounded chunks", () => {
  const units = [
    "word ",
    "3.14 ",
    "?",
    "!",
    "。",
    "中",
    "\n",
    "🧪",
    "NaOH/",
    "X",
  ];
  let seed = 731;
  for (let length = 1; length < 4000; length += 137) {
    let raw = "";
    while (raw.length < length) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      raw += units[seed % units.length];
    }
    checkRoundTrip(raw);
  }
});

// Load only this service in a VM with all I/O replaced. No Zotero instance,
// credentials or real endpoints are touched. TypeScript is a project dev dep.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const serviceSource = readFileSync(
  new URL("../src/modules/services/cnki.ts", import.meta.url),
  "utf8",
);
const serviceCode = ts.transpileModule(serviceSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const tokenModule = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    readFileSync(
      new URL("../src/modules/services/cnkiToken.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  { exports: tokenModule.exports, module: tokenModule },
);

function mockService(handler, prefOverrides = {}, isCurrent = () => true) {
  const preferences = {
    cnkiUseSplit: true,
    cnkiSplitSecond: 0,
    cnkiRegex: "^$",
    cnkiToken: JSON.stringify({ token: "mock-token", t: Date.now() }),
    ...prefOverrides,
  };
  const calls = [],
    refreshes = [],
    exports = {};
  const sandbox = {
    exports,
    setTimeout,
    ztoolkit: { log() {} },
    addon: {
      api: {
        getTemporaryRefreshHandler:
          ({ task }) =>
          () =>
            refreshes.push(task.result),
      },
    },
    Zotero: {
      HTTP: {
        request: async (method, url, options) => {
          const call = { method, url, options };
          calls.push(call);
          return handler(call, calls);
        },
      },
    },
    require: (id) => {
      if (id.endsWith("/crypto"))
        return {
          // Preserve source text for the fake endpoint. AES behavior is upstream.
          aesEcbEncrypt: async (text) => new TextEncoder().encode(text),
          base64: (buffer) => Buffer.from(buffer).toString("base64"),
        };
      if (id.endsWith("/prefs"))
        return {
          getPref: (key) => preferences[key],
          getPrefJSON: (key) => JSON.parse(preferences[key] || "{}"),
          setPref: (key, value) => (preferences[key] = value),
        };
      if (id === "./cnkiChunks") return { CNKI_MAX_TEXT_LENGTH, splitCnkiText };
      if (id === "./cnkiToken") return tokenModule.exports;
      if (id.endsWith("/task"))
        return { publishTranslateTaskProgress: () => isCurrent() };
      throw new Error(`Unexpected dependency in isolated CNKI test: ${id}`);
    },
  };
  vm.runInNewContext(serviceCode, sandbox, { filename: "cnki.test.cjs" });
  return { translate: exports.Cnki.translate, calls, refreshes, preferences };
}

const payload = (mResult, code = 200) => ({
  status: 200,
  response: { code, data: { mResult } },
});
const input = (raw) => ({ raw, result: "", silent: true });
const decodedWords = (call) =>
  Buffer.from(
    JSON.parse(call.options.body).words.replace(/_/g, "/").replace(/-/g, "+"),
    "base64",
  ).toString("utf8");

test("service sends every chunk verbatim, refreshes partial results, and bounds each HTTP request", async () => {
  const service = mockService((call) => payload(decodedWords(call)));
  const raw = "6.73 wt%? Na2SO3/NaOH! ".repeat(80) + "tail";
  const data = input(raw);
  await service.translate(data);
  assert.equal(service.calls.map(decodedWords).join(""), raw);
  assert.ok(service.calls.every((call) => decodedWords(call).length <= 800));
  assert.equal(service.refreshes.length, service.calls.length);
  assert.equal(data.raw, raw);
  assert.ok(data.result.endsWith("tail"));
  for (const call of service.calls) {
    assert.equal(call.options.timeout, 15000);
    assert.equal(call.options.errorDelayMax, 0);
  }
});

test("disabled splitting rejects long input without mutating or sending its first 800 characters", async () => {
  const service = mockService(() => assert.fail("must not request"), {
    cnkiUseSplit: false,
  });
  const data = input("X".repeat(801));
  await assert.rejects(service.translate(data), /启用分片翻译.*原文未截断/);
  assert.equal(data.raw.length, 801);
  assert.equal(service.calls.length, 0);
});

test("empty input produces no request and clears the result", async () => {
  const service = mockService(() => assert.fail("must not request"));
  const data = { ...input(""), result: "old" };
  await service.translate(data);
  assert.equal(data.result, "");
  assert.equal(service.calls.length, 0);
});

test("HTTP 401 refreshes a token normally once and retries the same encrypted request", async () => {
  let posts = 0;
  const service = mockService((call) => {
    if (call.method === "GET")
      return { status: 200, response: { code: 200, data: "new-mock-token" } };
    return ++posts === 1
      ? { status: 401, response: { code: 401, msg: "expired" } }
      : payload("译文");
  });
  const data = input("short text");
  await service.translate(data);
  assert.equal(data.result, "译文");
  assert.deepEqual(
    service.calls.map((call) => call.method),
    ["POST", "GET", "POST"],
  );
  assert.equal(service.calls[2].options.headers.Token, "new-mock-token");
  assert.equal(service.calls[0].options.body, service.calls[2].options.body);
});

test("repeated token rejection stops after one refresh and retains the server error", async () => {
  const service = mockService((call) =>
    call.method === "GET"
      ? { status: 200, response: { code: 200, data: "new-mock-token" } }
      : { status: 200, response: { code: 401, msg: "token-expired-original" } },
  );
  await assert.rejects(
    service.translate(input("text")),
    /刷新一次.*token-expired-original/,
  );
  assert.deepEqual(
    service.calls.map((call) => call.method),
    ["POST", "GET", "POST"],
  );
});

test("human verification is reported directly without retry or token refresh", async () => {
  const service = mockService(() => ({
    status: 200,
    response: {
      code: 401,
      msg: "human-check",
      data: { isInputVerificationCode: true },
    },
  }));
  await assert.rejects(
    service.translate(input("text")),
    /人工验证.*human-check/,
  );
  assert.equal(service.calls.length, 1);
});

test("missing mResult retains the original service detail rather than throwing replace of undefined", async () => {
  const service = mockService(() => ({
    status: 200,
    response: { code: 200, message: "original-empty-result", data: {} },
  }));
  await assert.rejects(
    service.translate(input("text")),
    /缺少 mResult.*original-empty-result/,
  );
  assert.equal(service.calls.length, 1);
});

test("network errors and service refusal are not retried and preserve their reason", async () => {
  const offline = mockService(() => {
    throw new Error("mock-network-timeout");
  });
  await assert.rejects(
    offline.translate(input("text")),
    /知网翻译请求失败.*mock-network-timeout/,
  );
  assert.equal(offline.calls.length, 1);
  const refused = mockService(() => ({
    status: 200,
    response: { code: 429, msg: "original-rate-limit", data: {} },
  }));
  await assert.rejects(
    refused.translate(input("text")),
    /服务拒绝.*original-rate-limit/,
  );
  assert.equal(refused.calls.length, 1);
});

test("malformed token response stops before translation and includes its service reason", async () => {
  const service = mockService(
    () => ({
      status: 200,
      response: { code: 500, msg: "original-token-error" },
    }),
    { cnkiToken: "{}" },
  );
  await assert.rejects(
    service.translate(input("text")),
    /未返回有效令牌.*original-token-error/,
  );
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].method, "GET");
  assert.equal(service.calls[0].options.timeout, 15000);
  assert.equal(service.calls[0].options.errorDelayMax, 0);
});

test("superseding a long selection stops subsequent chunk requests", async () => {
  let active = true;
  const service = mockService(
    () => {
      active = false;
      return payload("late first chunk");
    },
    {},
    () => active,
  );
  const data = input("x".repeat(2000));
  await service.translate(data);
  assert.equal(service.calls.length, 1);
  assert.equal(data.result, "");
  assert.equal(service.refreshes.length, 0);
});

test("cancellation during token retrieval does not start a translation request", async () => {
  let active = true;
  const service = mockService(
    () => {
      active = false;
      return {
        status: 200,
        response: { code: 200, data: "mock-refreshed-token" },
      };
    },
    { cnkiToken: "{}" },
    () => active,
  );
  await service.translate(input("short text"));
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].method, "GET");
});
