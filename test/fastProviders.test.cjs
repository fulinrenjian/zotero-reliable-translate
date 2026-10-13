const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function loadProvider(filename, request) {
  const source = path.join(
    __dirname,
    "..",
    "src",
    "modules",
    "services",
    filename,
  );
  const js = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    require(name) {
      throw new Error(`Unexpected runtime import: ${name}`);
    },
    Zotero: { HTTP: { request } },
  });
  return Object.values(module.exports)[0];
}

function task() {
  return {
    raw: "Hydrogen storage improves at 77 K and 1.0 bar.\nPores measure 0.6–0.8 nm.",
    langfrom: "en-US",
    langto: "zh-CN",
    result: "",
    status: "processing",
  };
}

const providers = [
  {
    filename: "bing.ts",
    id: "bing",
    label: "必应",
    response: [{ translations: [{ text: "储氢性能提高。" }] }],
    invalid: [
      undefined,
      null,
      [],
      { 0: { translations: [{ text: "fake" }] } },
      [{ translations: [] }],
      [{ translations: { 0: { text: "fake" } } }],
      [{ translations: [{ text: 123 }] }],
      [{ translations: [{ text: " \n\t" }] }],
      [{ translations: [{ text: "" }] }],
    ],
  },
  {
    filename: "tencenttransmart.ts",
    id: "tencenttransmart",
    label: "腾讯翻译君",
    response: { auto_translation: ["储氢性能提高。"] },
    invalid: [
      undefined,
      null,
      {},
      { auto_translation: "fake" },
      { auto_translation: [] },
      { auto_translation: [" \n\t", ""] },
      { auto_translation: [123] },
      { auto_translation: ["valid", { secretKey: "hidden" }] },
    ],
  },
];

for (const config of providers) {
  test(`${config.id} uses one bounded request without HTTP retry delays`, async () => {
    const calls = [];
    const provider = loadProvider(config.filename, async (...args) => {
      calls.push(args);
      return { status: 200, response: config.response };
    });
    const selected = task();
    await provider.translate(selected);
    assert.equal(provider.id, config.id);
    assert.equal(calls.length, 1);
    const [method, url, options] = calls[0];
    assert.equal(method, "POST");
    assert.equal(options.timeout, 8000);
    assert.equal(options.errorDelayMax, 0);
    assert.equal(options.responseType, "json");
    const body = JSON.parse(options.body);
    if (config.id === "bing") {
      assert.equal(
        url,
        "https://edge.microsoft.com/translate/translatetext?from=en-US&to=zh-CN&isEnterpriseClient=false",
      );
      assert.deepEqual(body, [selected.raw]);
      assert.equal(options.headers["content-type"], "application/json");
      assert.match(options.headers["User-Agent"], /Edg\/113\.0\.1774\.42$/);
    } else {
      assert.equal(url, "https://transmart.qq.com/api/imt");
      assert.deepEqual(body.source, { lang: "en", text_list: [selected.raw] });
      assert.deepEqual(body.target, { lang: "zh" });
      assert.equal(body.header.fn, "auto_translation");
      assert.equal(body.type, "plain");
      assert.equal(body.model_category, "normal");
      assert.equal(
        options.headers.referer,
        "https://transmart.qq.com/zh-CN/index",
      );
    }
    assert.equal(selected.result, "储氢性能提高。");
  });

  test(`${config.id} rejects empty or malformed translations rather than declaring success`, async () => {
    for (const response of config.invalid) {
      const provider = loadProvider(config.filename, async () => ({
        status: 200,
        response,
      }));
      const selected = task();
      await assert.rejects(provider.translate(selected), /未返回有效译文/);
      assert.equal(selected.result, "");
      assert.equal(selected.status, "processing");
    }
  });

  test(`${config.id} does not return service error payloads as translations`, async () => {
    const sensitive = "DoNotExposeRequestTokenOrResponse";
    const provider = loadProvider(config.filename, async () => ({
      status: 200,
      response: { error: sensitive, secretKey: sensitive, message: sensitive },
    }));
    await assert.rejects(provider.translate(task()), (error) => {
      assert.match(error.message, /未返回有效译文/);
      assert.ok(!error.message.includes(sensitive));
      return true;
    });
  });

  test(`${config.id} reports transport failures safely and makes no hidden retry`, async () => {
    let requests = 0;
    const sensitive = "SecretKey=DoNotExpose&text=OriginalParagraph";
    const provider = loadProvider(config.filename, async () => {
      requests++;
      throw new Error(sensitive);
    });
    const selected = task();
    await assert.rejects(provider.translate(selected), (error) => {
      assert.match(error.message, /请求失败/);
      assert.ok(!error.message.includes(sensitive));
      assert.ok(!error.message.includes(selected.raw));
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(selected.result, "");
  });

  test(`${config.id} provides a specific timeout message without exposing request data`, async () => {
    const provider = loadProvider(config.filename, async () => {
      throw { name: "TimeoutException", message: "SecretKey=DoNotExpose" };
    });
    await assert.rejects(provider.translate(task()), (error) => {
      assert.match(error.message, /请求超时（8 秒）/);
      assert.ok(!error.message.includes("SecretKey"));
      return true;
    });
  });

  test(`${config.id} rejects unsuccessful HTTP status without trusting its payload`, async () => {
    const provider = loadProvider(config.filename, async () => ({
      status: 503,
      response: config.response,
    }));
    const selected = task();
    await assert.rejects(provider.translate(selected), /服务暂不可用/);
    assert.equal(selected.result, "");
  });
}

test("tencenttransmart preserves translated parts and only trims outer whitespace", async () => {
  const provider = loadProvider("tencenttransmart.ts", async () => ({
    status: 200,
    response: { auto_translation: ["  第一行。", "第二行。  "] },
  }));
  const selected = task();
  await provider.translate(selected);
  assert.equal(selected.result, "第一行。\n第二行。");
});
