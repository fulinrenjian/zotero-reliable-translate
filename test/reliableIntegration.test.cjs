const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(relative, globals, resolve) {
  const filename = path.join(__dirname, "..", relative);
  const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    js,
    { module, exports: module.exports, require: resolve, ...globals },
    { filename },
  );
  return module.exports;
}

function task(overrides = {}) {
  return {
    id: "test",
    raw: "Hydrogen storage improves.",
    result: "",
    status: "waiting",
    type: "text",
    itemId: 1,
    service: "cnki",
    audio: [],
    extraTasks: [],
    candidateServices: [],
    ...overrides,
  };
}

function harness(
  processor = async (data) => {
    data.result = "储氢性能提高。";
    data.status = "success";
  },
) {
  const preferences = {
    sourceLanguage: "en-US",
    targetLanguage: "zh-CN",
    enableAutoDetectLanguage: true,
    disabledLanguages: "zh,zh-CN,中文;",
    splitChar: "",
    resultRegex: "",
    stripEmptyLines: false,
  };
  const state = {
    calls: 0,
    refreshed: 0,
    writes: 0,
    invalidated: 0,
    runnerCommits: true,
  };
  const topItem = { getField: () => "en" };
  const addon = {
    data: { alive: true, translate: { queue: [] } },
    api: { getTemporaryRefreshHandler: () => () => state.refreshed++ },
    hooks: { onReaderTabPanelRefresh() {} },
  };
  const helpers = {
    getPref: (key) => preferences[key],
    getString: (key) => key,
    sanitizeTaskForLog: (data) => data,
    getLastTranslateTask: () => addon.data.translate.queue.at(-1),
    autoDetectLanguage: () => ({
      fromLanguage: preferences.sourceLanguage,
      toLanguage: preferences.targetLanguage,
    }),
    matchLanguage: (language) => ({
      code: language === "Chinese" ? "zh-CN" : language,
    }),
    updateTranslateTaskLang: (data) => {
      data.langfrom = preferences.sourceLanguage;
      data.langto = preferences.targetLanguage;
    },
    invalidateTranslateTask: () => state.invalidated++,
    stripEmptyLines: (text) => text.trim(),
    TranslateTaskRunner: class {
      constructor(fn) {
        this.fn = fn;
      }
      async run(data) {
        state.calls++;
        await this.fn(data);
        return state.runnerCommits;
      }
    },
  };
  const providerExports = new Proxy(
    {},
    {
      get: (_target, name) => ({
        id: String(name).toLowerCase(),
        type: "sentence",
        translate: processor,
      }),
    },
  );
  const exports = load(
    "src/modules/services/index.ts",
    {
      addon,
      Zotero: { Items: { get: () => topItem, getTopLevel: () => [topItem] } },
      ztoolkit: {
        log() {},
        ExtraField: {
          setExtraField() {
            state.writes++;
          },
        },
      },
    },
    (name) => (name === "../../utils" ? helpers : providerExports),
  );
  return { services: exports.services, preferences, state, addon, topItem };
}

test("concurrent calls for one task issue one provider request", async () => {
  let release;
  const h = harness(async (data) => {
    await new Promise((r) => (release = r));
    data.result = "完成";
    data.status = "success";
  });
  const selected = task();
  h.addon.data.translate.queue.push(selected);
  const a = h.services.runTranslationTask(selected);
  const b = h.services.runTranslationTask(selected);
  assert.equal(h.state.calls, 1);
  release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(h.state.calls, 1);
});

test(
  "failed dictionary fallback completes without waiting on its own promise",
  { timeout: 500 },
  async () => {
    const h = harness(async (data) => {
      data.status = data.service === "bingdict" ? "fail" : "success";
      data.result = data.status === "fail" ? "字典不可用" : "储氢";
    });
    const selected = task({ service: "bingdict", candidateServices: ["cnki"] });
    assert.equal(await h.services.runTranslationTask(selected), true);
    assert.equal(selected.service, "cnki");
    assert.equal(h.state.calls, 2);
  },
);

test("disabled language is an explicit failure and manual retry bypasses it", async () => {
  const h = harness();
  h.preferences.sourceLanguage = "zh-CN";
  h.topItem.getField = () => "zh-CN";
  const selected = task();
  assert.equal(await h.services.runTranslationTask(selected), false);
  assert.equal(selected.status, "fail");
  assert.match(selected.result, /Ctrl\+T/);
  assert.equal(h.state.calls, 0);
  assert.equal(
    await h.services.runTranslationTask(selected, {
      noCheckZoteroItemLanguage: true,
    }),
    true,
  );
});

test("Chinese bibliography is respected even when the default source is English", async () => {
  const h = harness();
  h.topItem.getField = () => "Chinese";
  const selected = task();
  assert.equal(await h.services.runTranslationTask(selected), false);
  assert.equal(selected.status, "fail");
  assert.equal(h.state.calls, 0);
});

test("changing target language does not reuse a translation in the old language", async () => {
  const h = harness();
  h.addon.data.translate.queue.push(
    task({
      id: "old",
      status: "success",
      result: "ancien",
      langfrom: "en-US",
      langto: "fr-FR",
    }),
  );
  const selected = task();
  h.addon.data.translate.queue.push(selected);
  assert.equal(await h.services.runTranslationTask(selected), true);
  assert.equal(h.state.calls, 1);
  assert.equal(selected.langto, "zh-CN");
  assert.equal(selected.result, "储氢性能提高。");
});

test("a post-processing expression that erases the result cannot report success", async () => {
  const h = harness();
  h.preferences.resultRegex = "[\\s\\S]*";
  const selected = task();
  assert.equal(await h.services.runTranslationTask(selected), false);
  assert.equal(selected.status, "fail");
  assert.match(selected.result, /未返回可用译文/);
});

test("an invalid result expression reports a failure rather than a translated result", async () => {
  const h = harness();
  h.preferences.resultRegex = "[";
  const selected = task();
  assert.equal(await h.services.runTranslationTask(selected), false);
  assert.equal(selected.status, "fail");
});

test("superseded provider invocations cannot format, fallback, or write item fields", async () => {
  const h = harness(async (data) => {
    data.result = "old";
    data.status = "success";
  });
  h.state.runnerCommits = false;
  const selected = task({ type: "title" });
  assert.equal(await h.services.runTranslationTask(selected), false);
  assert.equal(h.state.writes, 0);
});

test("plugin shutdown blocks persistence even when an HTTP response arrives", async () => {
  const h = harness(async (data) => {
    h.addon.data.alive = false;
    data.result = "old";
    data.status = "success";
  });
  assert.equal(
    await h.services.runTranslationTask(task({ type: "title" })),
    false,
  );
  assert.equal(h.state.writes, 0);
});

test("progress handlers allow two readers and reject expired attempts", () => {
  const state = { popup: 0, panel: 0 };
  const expired = new Set();
  const addon = {
    data: { alive: true, translate: {} },
    hooks: {
      onReaderPopupRefresh: () => state.popup++,
      onReaderTabPanelRefresh: () => state.panel++,
    },
  };
  const api = load("src/api.ts", { addon, Zotero: {} }, (name) =>
    name === "./utils/task"
      ? {
          publishTranslateTaskProgress: (task) => !expired.has(task.id),
        }
      : name === "../package.json"
        ? { version: "0.1.0" }
        : { getPref: () => false },
  ).default;
  const a = task({ id: "reader-a" }),
    b = task({ id: "reader-b" });
  const first = api.getTemporaryRefreshHandler({ task: a });
  const second = api.getTemporaryRefreshHandler({ task: b });
  first();
  second();
  assert.equal(state.popup, 2);
  expired.add(a.id);
  first();
  assert.equal(state.popup, 2);
  addon.data.alive = false;
  second();
  assert.equal(state.popup, 2);
});

async function hookHarness({ activate = true } = {}) {
  const selection = load("src/utils/reliableSelection.ts", {}, () => {
    throw new Error("unexpected import");
  });
  const queue = [],
    calls = [],
    cancelled = [];
  const main = { Zotero_Tabs: { selectedID: "A", selectedType: "reader" } };
  const iframeA = {};
  iframeA.parent = iframeA;
  const iframeB = {};
  iframeB.parent = iframeB;
  const standalone = {
    location: { href: "chrome://zotero/content/reader.xhtml" },
  };
  standalone.parent = standalone;
  const readers = [
    { _instanceID: "reader-a", tabID: "A", itemID: 1, _iframeWindow: iframeA },
    { _instanceID: "reader-b", tabID: "B", itemID: 2, _iframeWindow: iframeB },
    { _instanceID: "reader-d", itemID: 3, _window: standalone },
  ];
  const preferences = {
    enableAuto: true,
    enableConcatKey: true,
    translateSource: "cnki",
    dictSource: "bingdict",
    enableDict: true,
    sourceLanguage: "en-US",
    targetLanguage: "zh-CN",
    disabledLanguages: "zh",
  };
  const addon = {
    data: {
      alive: true,
      translate: {
        queue,
        selectedText: "",
        concatCheckbox: false,
        concatKey: false,
        services: {
          runTranslationTask: async (selected) => {
            calls.push(selected);
            selected.status = "processing";
            return true;
          },
        },
        batchTaskDelay: 0,
      },
      popup: { currentPopup: null },
    },
    api: { getTemporaryRefreshHandler: () => () => {} },
  };
  const zotero = {
    initializationPromise: Promise.resolve(),
    unlockPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    getMainWindow: () => main,
    getMainWindows: () => [],
    Reader: {
      _readers: readers,
      getByTabID: (id) => readers.find((r) => r.tabID === id),
    },
    Utilities: { randomString: () => String(queue.length) },
    Promise: { delay: async () => {} },
    isMac: false,
  };
  const pref = { getPref: (key) => preferences[key] };
  const bindingsModule = load(
    "src/modules/reliablePopupBinding.ts",
    { addon, Zotero: zotero },
    (name) => (name.includes("reliableSelection") ? selection : pref),
  );
  const taskHelpers = {
    getLastTranslateTask: (conditions) =>
      queue.findLast(
        (value) =>
          !conditions ||
          Object.keys(conditions).every(
            (key) => value[key] === conditions[key],
          ),
      ),
    addTranslateTask: (raw, itemId, type = "text", service, options = {}) => {
      if (
        !options.forceNew &&
        !service &&
        (addon.data.translate.concatKey ||
          addon.data.translate.concatCheckbox) &&
        queue.length
      ) {
        queue.at(-1).raw += " " + raw;
        return;
      }
      const created = task({
        id: "created-" + queue.length,
        raw,
        itemId,
        type,
        service: service || "cnki",
      });
      queue.push(created);
      return created;
    },
    invalidateTranslateTask: (selected) => cancelled.push(selected.id),
    invalidateAllTranslateTasks() {},
  };
  const noop = new Proxy({}, { get: () => () => {} });
  const popup = {
    buildReaderPopup: (event, selected) => {
      addon.data.popup.currentPopup = event.popup;
      bindingsModule.popupBindings.bind(
        event.reader._instanceID,
        selected,
        event.popup,
      );
    },
    updateReaderPopup() {},
    disposeReaderPopups() {},
  };
  const hooks = load(
    "src/hooks.ts",
    {
      addon,
      Zotero: zotero,
      __env__: "production",
      ztoolkit: { log() {}, unregisterAll() {} },
    },
    (name) => {
      if (name === "../package.json")
        return {
          config: { addonID: "test", addonRef: "test", addonInstance: "test" },
        };
      if (name === "./utils/task") return taskHelpers;
      if (name === "./utils/prefs") return pref;
      if (name === "./utils/reliableSelection") return selection;
      if (name === "./modules/reliablePopupBinding") return bindingsModule;
      if (name === "./modules/reliableSetup")
        return {
          prepareReliableSetup: async () => ({
            shouldActivate: activate,
            migrated: false,
          }),
        };
      if (name === "./modules/popup") return popup;
      return noop;
    },
  ).default;
  addon.hooks = hooks;
  await hooks.onStartup();
  function choose(reader, raw, popupNode = { isConnected: true }) {
    addon.data.translate.selectedText = raw;
    hooks.onReaderPopupShow({ reader, popup: popupNode });
    return bindingsModule.popupBindings.getCurrentTask(reader._instanceID);
  }
  return {
    readers,
    queue,
    calls,
    cancelled,
    main,
    standalone,
    iframeA,
    preferences,
    addon,
    hooks,
    bindingsModule,
    choose,
    zotero,
  };
}

test("reopening one pending selection shares work; failed selection can retry", async () => {
  const h = await hookHarness();
  const first = h.choose(h.readers[0], "one sentence");
  assert.equal(h.choose(h.readers[0], "one sentence"), first);
  assert.equal(h.calls.length, 1);
  first.status = "fail";
  const retry = h.choose(h.readers[0], "one sentence");
  assert.notEqual(retry, first);
  assert.equal(h.calls.length, 2);
});

test("changing a reader selection cancels only its previous processing request", async () => {
  const h = await hookHarness();
  const a = h.choose(h.readers[0], "first");
  const b = h.choose(h.readers[1], "other PDF");
  const fresh = h.choose(h.readers[0], "second");
  assert.equal(a.status, "fail");
  assert.equal(b.status, "processing");
  assert.deepEqual(h.cancelled, [a.id]);
  assert.equal(fresh.raw, "second");
});

test("concatenation uses the current reader rather than another PDF queue tail", async () => {
  const h = await hookHarness();
  const a = h.choose(h.readers[0], "A first");
  const b = h.choose(h.readers[1], "B first");
  h.addon.data.translate.concatKey = true;
  const joined = h.choose(h.readers[0], "A second");
  assert.equal(joined.raw, "A first A second");
  assert.equal(b.raw, "B first");
  assert.notEqual(joined, a);
});

test("starting concatenation in a different reader never appends to its neighbor", async () => {
  const h = await hookHarness();
  const b = h.choose(h.readers[1], "B only");
  h.addon.data.translate.concatCheckbox = true;
  assert.equal(h.choose(h.readers[0], "A only").raw, "A only");
  assert.equal(b.raw, "B only");
});

test("reselecting native text after editing the sidebar source creates a correct task", async () => {
  const h = await hookHarness();
  const edited = h.choose(h.readers[0], "native text");
  edited.raw = "manual edit";
  edited.status = "success";
  assert.equal(h.choose(h.readers[0], "native text").raw, "native text");
});

test("manual shortcuts resolve independent reader windows and nested PDF iframes", async () => {
  const h = await hookHarness();
  const a = h.choose(h.readers[0], "A");
  const d = h.choose(h.readers[2], "standalone");
  a.status = "fail";
  d.status = "fail";
  h.main.Zotero_Tabs.selectedID = "library";
  h.hooks.onShortcuts("reader", h.standalone);
  assert.equal(h.calls.at(-1), d);
  const nested = { parent: h.iframeA };
  h.hooks.onShortcuts("reader", nested);
  assert.equal(h.calls.at(-1), a);
});

test("paused startup cannot register a translation window or trigger shortcuts", async () => {
  const h = await hookHarness({ activate: false });
  await h.hooks.onMainWindowLoad({});
  h.queue.push(task());
  h.hooks.onShortcuts("reader");
  assert.equal(h.calls.length, 0);
});
