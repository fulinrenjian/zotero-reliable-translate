const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { Script } = require("node:vm");
const ts = require("typescript");

const source = ts.transpileModule(
  readFileSync(resolve(__dirname, "../src/elements/panel.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function fixture() {
  const tasks = new Map(),
    bindings = new Map(),
    calls = [],
    copies = [],
    invalidated = [];
  const prefs = new Map([
    ["translateSource", "cnki"],
    ["sourceLanguage", "en-US"],
    ["targetLanguage", "zh-CN"],
    ["rawResultOrder", false],
    ["fontSize", 12],
    ["lineHeight", "1.5"],
  ]);
  const panels = [];
  let nextID = 0;
  function node() {
    const listeners = new Map();
    return {
      value: "",
      style: {},
      nextElementSibling: null,
      querySelector: () => null,
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      fire(type, value) {
        if (value !== undefined) this.value = value;
        return listeners.get(type)?.({ target: this });
      },
    };
  }
  class Base {
    constructor() {
      this.nodes = new Map();
    }
    _queryID(key) {
      if (!this.nodes.has(key)) this.nodes.set(key, node());
      return this.nodes.get(key);
    }
  }
  const serviceAPI = {
    getServiceById: (id) => ({
      id,
      type: id === "bingdict" ? "word" : "sentence",
    }),
    getAllServices: () => [
      { id: "cnki" },
      { id: "googleapi" },
      { id: "bingdict" },
    ],
    getServiceNameByID: (id) => id,
    getUnconfiguredServiceIds: () => new Set(),
  };
  const addon = {
    data: {
      translate: {
        services: serviceAPI,
        concatCheckbox: false,
        cachedSourceLanguage: {},
      },
      ztoolkit: {
        Clipboard: class {
          addText(value) {
            this.value = value;
            return this;
          }
          copy() {
            copies.push(this.value);
          }
        },
      },
    },
    hooks: {
      onTranslate: (task, options) => {
        assert.ok(task, "panel must pass an explicit task");
        calls.push({ task, options });
        return Promise.resolve();
      },
      onReaderTabPanelRefresh: () => panels.forEach((panel) => panel.render()),
    },
  };
  const makeTask = (id, raw, itemId = 11) => {
    const task = {
      id,
      type: "text",
      raw,
      result: `translated ${raw}`,
      itemId,
      service: "cnki",
      status: "success",
      langfrom: "en-US",
      langto: "zh-CN",
      audio: [],
      extraTasks: [],
    };
    tasks.set(id, task);
    return task;
  };
  const imports = {
    "../../package.json": {
      config: {
        addonRef: "fixturetranslate",
        addonInstance: "FixtureTranslate",
      },
    },
    "./base": { PluginCEBase: Base },
    "../utils/prefs": {
      getPref: (key) => (prefs.has(key) ? prefs.get(key) : true),
      setPref: (key, value) => prefs.set(key, value),
    },
    "../utils/config": { LANG_CODE: [] },
    "../utils/task": {
      getLastTranslateTask: (conditions) => {
        assert.ok(conditions?.id, "unscoped global lookup is forbidden");
        return tasks.get(conditions.id);
      },
      addTranslateTask: (raw, itemId, type, service) => {
        assert.ok(
          service,
          "manual edits/retries must not enter shared concat mode",
        );
        const task = makeTask(`manual-${++nextID}`, raw, itemId);
        task.type = type;
        task.service = service;
        task.status = "waiting";
        task.result = "";
        return task;
      },
      autoDetectLanguage: () => ({
        fromLanguage: "en-US",
        toLanguage: "zh-CN",
      }),
      invalidateTranslateTask: (task) => invalidated.push(task.id),
    },
    "../modules/reliablePopupBinding": {
      popupBindings: { getCurrentTask: (key) => bindings.get(key) },
    },
  };
  const module = { exports: {} };
  new Script(source).runInNewContext({
    module,
    exports: module.exports,
    require: (id) => {
      assert.ok(Object.hasOwn(imports, id), id);
      return imports[id];
    },
    Zotero: { FixtureTranslate: addon },
    window: { document: { addEventListener() {}, removeEventListener() {} } },
  });
  function panel(readerKey) {
    const p = new module.exports.TranslatorPanel();
    p._addon = addon;
    p.item = { id: 11 };
    if (readerKey) p.setReaderContext(readerKey, 11);
    panels.push(p);
    p.init();
    return p;
  }
  const a = makeTask("a", "reader A passage"),
    b = makeTask("b", "reader B passage");
  bindings.set("reader-a", a);
  bindings.set("reader-b", b);
  return {
    panel,
    tasks,
    bindings,
    makeTask,
    calls,
    copies,
    invalidated,
    a,
    b,
    prefs,
  };
}

test("two readers of the same PDF render only their own bound tasks", () => {
  const f = fixture(),
    a = f.panel("reader-a"),
    b = f.panel("reader-b");
  a.render();
  b.render();
  a.render();
  assert.equal(a._queryID("raw-text").value, f.a.raw);
  assert.equal(b._queryID("raw-text").value, f.b.raw);
  assert.equal(a._taskID, "a");
  assert.equal(b._taskID, "b");
});

test("changing reader A's source sends an explicit A task and never modifies reader B", () => {
  const f = fixture(),
    a = f.panel("reader-a"),
    b = f.panel("reader-b");
  a.render();
  b.render();
  a._queryID("services").fire("command", "googleapi");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].task.raw, f.a.raw);
  assert.equal(f.calls[0].task.service, "googleapi");
  assert.equal(f.b.service, "cnki");
  assert.equal(b._taskID, "b");
  assert.equal(b._queryID("raw-text").value, f.b.raw);
});

test("editing raw text and translating uses the panel-owned task after another reader updates", () => {
  const f = fixture(),
    a = f.panel("reader-a"),
    b = f.panel("reader-b");
  a.render();
  b.render();
  a._queryID("raw-text").fire("input", "manually edited A text");
  const ownID = a._taskID;
  f.bindings.set("reader-b", f.makeTask("b-new", "new B selection"));
  b.render();
  a.render();
  a._queryID("translate").fire("command");
  assert.equal(f.calls.at(-1).task.id, ownID);
  assert.equal(f.calls.at(-1).task.raw, "manually edited A text");
  assert.equal(f.a.raw, "reader A passage");
  assert.equal(b._queryID("raw-text").value, "new B selection");
});

test("standalone translation keeps its task while other reader selections change", () => {
  const f = fixture(),
    standalone = f.panel();
  standalone.adoptTask(f.a);
  standalone.render();
  f.bindings.set("reader-a", f.makeTask("a-new", "new A selection"));
  f.bindings.set("reader-b", f.makeTask("b-new", "new B selection"));
  standalone.render();
  assert.equal(standalone._taskID, "a");
  assert.equal(standalone._queryID("raw-text").value, "reader A passage");
});

test("a new selection replaces a manual task only in the reader that selected it", () => {
  const f = fixture(),
    a = f.panel("reader-a"),
    b = f.panel("reader-b");
  a.render();
  b.render();
  a._queryID("raw-text").fire("input", "manual A");
  f.bindings.set("reader-a", f.makeTask("a-new", "fresh A selection"));
  a.render();
  b.render();
  assert.equal(a._taskID, "a-new");
  assert.equal(b._taskID, "b");
  assert.equal(a._queryID("raw-text").value, "fresh A selection");
});

test("clear concat, copy and language changes stay within the panel's own task", () => {
  const f = fixture(),
    a = f.panel("reader-a"),
    b = f.panel("reader-b");
  a.render();
  b.render();
  a._queryID("langfrom").fire("command", "de-DE");
  assert.equal(a.getTask().langfrom, "de-DE");
  assert.equal(f.b.langfrom, "en-US");
  a._queryID("copy-raw").fire("command");
  assert.equal(f.copies.at(-1), f.a.raw);
  a._queryID("clear-concat").fire("command");
  assert.equal(a._queryID("raw-text").value, "");
  assert.equal(b._queryID("raw-text").value, f.b.raw);
  assert.equal(f.b.raw, "reader B passage");
});

test("dictionary selection does not replace the default paragraph translation engine", () => {
  const f = fixture(),
    a = f.panel("reader-a");
  a.render();
  a._queryID("services").fire("command", "bingdict");
  assert.equal(f.prefs.get("dictSource"), "bingdict");
  assert.equal(f.prefs.get("translateSource"), "cnki");
  assert.equal(f.calls.at(-1).task.service, "bingdict");
});

test("manual result editing invalidates pending publication without changing another reader", () => {
  const f = fixture(),
    a = f.panel("reader-a"),
    b = f.panel("reader-b");
  f.a.status = "processing";
  a.render();
  b.render();
  a._queryID("result-text").fire("input", "manually corrected translation");
  assert.deepEqual(f.invalidated, ["a"]);
  assert.equal(f.a.status, "success");
  assert.equal(f.a.result, "manually corrected translation");
  assert.equal(f.b.result, "translated reader B passage");
});
