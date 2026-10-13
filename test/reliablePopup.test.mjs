import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { ReliableSelectionBindings } from "../src/utils/reliableSelection.ts";
import { getPopupPresentation } from "../src/utils/reliablePopupPresenter.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
const runnerExports = {};
vm.runInNewContext(compile("../src/utils/reliableRun.ts"), {
  exports: runnerExports,
  setTimeout,
  clearTimeout,
});
const { redactServiceError } = runnerExports;
const popupCode = compile("../src/modules/popup.ts");

const task = (
  id,
  raw,
  status = "waiting",
  result = "",
  service = "cnki",
  itemId = 1,
) => ({
  id,
  raw,
  status,
  result,
  service,
  itemId,
  type: "text",
  audio: [],
  candidateServices: [],
  extraTasks: [],
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { resolve, promise };
};

// Minimal DOM event/tree mock. Tests exercise popup.ts itself; it does not render
// layout or make claims about the native Zotero view, which needs the real app.
class Element {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.className = "";
    this._connected = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  get isConnected() {
    return this._connected;
  }
  connect(value) {
    this._connected = value;
    for (const child of this.children) child.connect(value);
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
      child.connect(this.isConnected);
    }
    this.ownerDocument.notify();
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    this.parent = undefined;
    this.connect(false);
    this.ownerDocument.notify();
  }
  replaceChildren(...children) {
    for (const child of this.children) {
      child.parent = undefined;
      child.connect(false);
    }
    this.children = [];
    this.append(...children);
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  getAttribute(key) {
    return this.attributes[key] ?? null;
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((item) => item !== handler),
    );
  }
  fire(type, detail = {}) {
    if (type === "click" && this.disabled) return;
    const event = {
      type,
      target: this,
      stopPropagation() {},
      preventDefault() {},
      ...detail,
    };
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
  querySelector(selector) {
    return find(this, (element) =>
      selector === ".selection-popup"
        ? element.className === "selection-popup"
        : selector === ".colors" && element.className === "colors",
    );
  }
  get offsetLeft() {
    return Number.parseFloat(this.style.left || "100");
  }
  get offsetTop() {
    return Number.parseFloat(this.style.top || "50");
  }
  getBoundingClientRect() {
    const width = Math.min(
      Number.parseFloat(this.style.width || "180"),
      this.ownerDocument.documentElement.clientWidth - 16,
    );
    return {
      left: this.offsetLeft,
      top: this.offsetTop,
      width,
      height: 220,
      right: this.offsetLeft + width,
      bottom: this.offsetTop + 220,
    };
  }
}
function find(root, predicate) {
  for (const child of root.children) {
    if (predicate(child)) return child;
    const nested = find(child, predicate);
    if (nested) return nested;
  }
}
class Document {
  constructor() {
    this.observers = new Set();
    this.documentElement = { clientWidth: 1200, clientHeight: 800 };
    this.body = new Element(this, "body");
    this.body.connect(true);
    this.defaultView = new Element(this, "window");
    this.contentObserverAttempts = 0;
    const owner = this;
    this.defaultView.MutationObserver = class {
      constructor() {
        owner.contentObserverAttempts++;
        throw new TypeError(
          "MutationObserver.observe: One of 'childList', 'attributes', 'characterData' must not be false.",
        );
      }
    };
  }
  createElement(tag) {
    return new Element(this, tag);
  }
  querySelector(selector) {
    return this.body.querySelector(selector);
  }
  notify() {
    queueMicrotask(() => {
      for (const observer of this.observers) observer.callback();
    });
  }
}

function mockPopup(onTranslate, extraPrefs = {}) {
  const bindings = new ReliableSelectionBindings();
  const remembered = [],
    invalidations = [],
    translates = [],
    copies = [],
    plays = [],
    prefWrites = [],
    notes = [],
    notifications = [],
    logs = [],
    observerSnapshots = [];
  const prefs = {
    enablePopup: true,
    enableNote: false,
    showPlayBtn: true,
    autoPlay: false,
    fontSize: 14,
    lineHeight: 1.5,
    translateSource: "cnki",
    dictSource: "youdaodict",
    ...extraPrefs,
  };
  const list = [
    { id: "cnki", type: "sentence" },
    { id: "bing", type: "sentence" },
    { id: "deepl-key", type: "sentence" },
    { id: "youdaodict", type: "word" },
    { id: "other-word", type: "word" },
  ];
  const services = {
    getAllServices: () => list,
    getServiceById: (id) => list.find((service) => service.id === id),
    getServiceNameByID: (id) =>
      ({
        cnki: "知网",
        bing: "必应",
        "deepl-key": "DeepL",
        youdaodict: "有道词典",
      })[id] || id,
    getUnconfiguredServiceIds: () => new Set(["deepl-key"]),
  };
  const addon = {
    data: {
      popup: { currentPopup: null },
      translate: { services, selectedText: "WRONG GLOBAL TEXT" },
    },
    hooks: {
      onTranslate: async (task, options) => {
        translates.push({ task, options });
        task.status = "processing";
        if (onTranslate) return onTranslate(task, options);
        task.status = "success";
        task.result = `translation-${task.id}`;
      },
    },
  };
  class ChromeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.documents = new Set();
      const popup = addon.data.popup.currentPopup;
      observerSnapshots.push({
        taskId: bindings.getForPopup(popup)?.taskId,
        status: find(
          popup,
          (element) => element.dataset.reliableRole === "status",
        )?.textContent,
        width: popup?.style.width,
      });
    }
    observe(target, options) {
      if (prefs.observerThrows)
        throw new Error("SIMULATED_PRIVATE_ERROR_DO_NOT_LOG");
      assert.ok(
        options.childList || options.attributes || options.characterData,
      );
      this.documents.add(target.ownerDocument);
      target.ownerDocument.observers.add(this);
    }
    disconnect() {
      for (const doc of this.documents) doc.observers.delete(this);
      this.documents.clear();
    }
  }
  let serial = 0;
  const exports = {};
  vm.runInNewContext(popupCode, {
    exports,
    addon,
    Zotero: {
      getMainWindow: () => ({
        MutationObserver: ChromeMutationObserver,
        ZoteroContextPane: {
          activeEditor: prefs.enableNote
            ? { getCurrentInstance: () => ({}) }
            : undefined,
        },
      }),
    },
    ztoolkit: {
      ProgressWindow: class {
        constructor(title) {
          this.title = title;
        }
        createLine(line) {
          this.line = line;
          return this;
        }
        show() {
          notifications.push({ title: this.title, ...this.line });
        }
      },
      Clipboard: class {
        addText(text) {
          this.text = text;
          return this;
        }
        copy() {
          copies.push(this.text);
        }
      },
      getGlobal: (name) => {
        assert.equal(name, "Audio");
        return class {
          constructor(url) {
            this.url = url;
          }
          play() {
            plays.push(this.url);
            return Promise.resolve();
          }
        };
      },
      log(message) {
        logs.push(message);
      },
    },
    require: (id) => {
      if (id.endsWith("package.json"))
        return { config: { addonRef: "test-reliable" } };
      if (id.endsWith("/prefs"))
        return {
          getPref: (key) => prefs[key],
          setPref: (key, value) => {
            prefs[key] = value;
            prefWrites.push([key, value]);
          },
        };
      if (id.endsWith("/task"))
        return {
          invalidateTranslateTask: (task) => invalidations.push(task),
          addTranslateTask: (raw, itemId, type, service) => ({
            ...task(`new-${++serial}`, raw, "waiting", "", service, itemId),
            type,
          }),
        };
      if (id.endsWith("/reliableRun")) return { redactServiceError };
      if (id.endsWith("/reliablePopupPresenter"))
        return { getPopupPresentation };
      if (id === "./reliablePopupBinding")
        return {
          popupBindings: bindings,
          rememberSelectionSettings: (task) => remembered.push(task),
        };
      if (id === "./reliableNote")
        return {
          saveSelectionToNote: async ({
            task,
            reader,
            annotation,
            isCurrent,
          }) => {
            if (prefs.noteSaveGate) await prefs.noteSaveGate;
            if (prefs.noteSaveError) throw new Error(prefs.noteSaveError);
            if (!isCurrent())
              throw new Error("选区已变化，本次加入笔记已取消。");
            notes.push([
              {
                ...annotation,
                text: task.raw,
                comment: task.result,
                attachmentItemID: reader.itemID,
              },
            ]);
            return {
              mode: "child",
              noteID: 77,
              opened: true,
              message: "已新建当前文献的译文笔记。",
            };
          },
        };
      throw new Error(`Unexpected popup dependency: ${id}`);
    },
  });
  function reader(key = "reader", itemID = 1) {
    const doc = new Document();
    const popup = doc.createElement("div");
    popup.className = "selection-popup";
    const colors = doc.createElement("div");
    colors.className = "colors";
    popup.append(colors);
    doc.body.append(popup);
    const event = {
      reader: {
        _instanceID: key,
        itemID,
        _addToNote: (annotations) => notes.push(annotations),
      },
      doc,
      params: { annotation: { text: "original annotation", color: "#ffd400" } },
      append: (element) => popup.append(element),
    };
    const controls = () =>
      Object.fromEntries(
        [
          "panel",
          "raw",
          "result",
          "status",
          "text",
          "translate",
          "copy",
          "source",
          "addtonote",
          "audio",
        ].map((role) => [
          role,
          find(popup, (element) => element.dataset.reliableRole === role),
        ]),
      );
    return { event, doc, popup, colors, controls };
  }
  return {
    ...exports,
    reader,
    bindings,
    remembered,
    invalidations,
    translates,
    copies,
    plays,
    prefWrites,
    prefs,
    notes,
    notifications,
    logs,
    observerSnapshots,
    addon,
  };
}

test("presenter never substitutes source text for an unfinished translation", () => {
  const waiting = getPopupPresentation(task("t", "This is the source"));
  assert.equal(waiting.statusLabel, "等待翻译");
  assert.notEqual(waiting.text, "This is the source");
  assert.equal(waiting.copyDisabled, true);
  const partial = getPopupPresentation(
    task("t", "source", "processing", "部分译文"),
  );
  assert.equal(partial.statusLabel, "正在翻译…");
  assert.equal(partial.text, "部分译文");
  assert.equal(partial.translateDisabled, true);
  assert.equal(partial.copyDisabled, true);
});

test("presenter treats whitespace-only success as failure and sanitizes errors", () => {
  const empty = getPopupPresentation(task("t", "source", "success", "  \n"));
  assert.equal(empty.statusLabel, "翻译失败");
  assert.equal(empty.copyText, "");
  const failed = getPopupPresentation(
    task("t", "source", "fail", "Bearer mock-credential"),
    "result",
    (text) => redactServiceError(text),
  );
  assert.ok(!failed.text.includes("mock-credential"));
  assert.equal(failed.translateLabel, "重试");
  assert.equal(failed.copyDisabled, true);
});

test("actual popup retains colors, renders status/tabs, and bounds the new panel", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  const initial = task("initial", "source text");
  ui.buildReaderPopup(reader.event, initial);
  const c = reader.controls();
  assert.equal(reader.popup.children[0], reader.colors);
  assert.equal(c.status.textContent, "等待翻译");
  assert.equal(c.copy.disabled, true);
  assert.equal(reader.popup.style.width, "320px");
  assert.equal(reader.popup.style.maxWidth, "calc(100vw - 16px)");
  assert.equal(c.panel.style.maxHeight, "240px");
  assert.equal(c.panel.style.overflowY, "auto");
  c.raw.fire("click");
  assert.equal(c.text.value, initial.raw);
  c.result.fire("click");
  assert.notEqual(c.text.value, initial.raw);
  assert.equal(reader.doc.observers.size, 1);
  ui.disposeReaderPopups();
});

test("two readers render only their own task, never global source/result", () => {
  const ui = mockPopup();
  const a = ui.reader("a", 1),
    b = ui.reader("b", 2);
  const first = {
    ...task("a", "same source", "fail", "Bearer mock-credential"),
    secret: "mock-credential",
  };
  const second = task(
    "b",
    "same source",
    "success",
    "reader B translation",
    "bing",
    2,
  );
  ui.buildReaderPopup(a.event, first);
  ui.buildReaderPopup(b.event, second);
  ui.updateReaderPopup();
  assert.equal(a.controls().status.textContent, "翻译失败");
  assert.ok(!a.controls().text.value.includes("mock-credential"));
  assert.equal(a.controls().copy.disabled, true);
  assert.equal(b.controls().text.value, second.result);
  assert.equal(b.controls().copy.disabled, false);
  b.controls().copy.fire("click");
  a.controls().copy.fire("click");
  assert.deepEqual(ui.copies, [second.result]);
  ui.disposeReaderPopups();
});

test("retry creates a fresh scoped task, blocks duplicate clicks, and ignores the old result", async () => {
  const response = deferred();
  const ui = mockPopup(async (task) => {
    await response.promise;
    task.status = "success";
    task.result = "fresh result";
  });
  const reader = ui.reader("scope", 42);
  const old = task(
    "old",
    "retry this exact passage",
    "fail",
    "network error",
    "cnki",
    42,
  );
  ui.buildReaderPopup(reader.event, old);
  reader.controls().translate.fire("click");
  const fresh = ui.bindings.getForPopup(reader.popup).task;
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.raw, old.raw);
  assert.equal(fresh.itemId, 42);
  assert.equal(fresh.service, "cnki");
  assert.equal(reader.controls().translate.disabled, true);
  reader.controls().translate.fire("click");
  assert.equal(ui.translates.length, 1);
  assert.equal(ui.translates[0].options.noCache, true);
  assert.equal(ui.translates[0].options.noCheckZoteroItemLanguage, true);
  old.status = "success";
  old.result = "late old result";
  ui.updateReaderPopup();
  assert.notEqual(reader.controls().text.value, old.result);
  response.resolve();
  await flush();
  assert.equal(reader.controls().text.value, "fresh result");
  assert.equal(reader.controls().copy.disabled, false);
  assert.equal(ui.remembered[0], fresh);
  ui.disposeReaderPopups();
});

test("source menu marks missing configuration and source switching changes only its scoped preference", async () => {
  const ui = mockPopup();
  const reader = ui.reader();
  ui.buildReaderPopup(
    reader.event,
    task("word", "adsorption", "waiting", "", "youdaodict"),
  );
  const source = reader.controls().source;
  assert.deepEqual(
    source.children.map((option) => option.value),
    ["cnki", "bing", "deepl-key", "youdaodict"],
  );
  const unavailable = source.children.find(
    (option) => option.value === "deepl-key",
  );
  assert.equal(unavailable.disabled, true);
  assert.match(unavailable.textContent, /需配置/);
  source.value = "deepl-key";
  source.fire("change");
  assert.equal(ui.translates.length, 0);
  source.value = "bing";
  source.fire("change");
  await flush();
  assert.equal(ui.bindings.getForPopup(reader.popup).task.service, "bing");
  assert.deepEqual(ui.prefWrites, [["translateSource", "bing"]]);
  assert.equal(ui.prefs.dictSource, "youdaodict");
  assert.equal(source.value, "bing");
  ui.disposeReaderPopups();
});

test("rebuilding an existing popup keeps one panel and binding to the latest selection", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  ui.buildReaderPopup(
    reader.event,
    task("first", "first", "success", "first result"),
  );
  const panel = reader.controls().panel;
  ui.buildReaderPopup(
    reader.event,
    task("second", "second", "success", "second result"),
  );
  assert.equal(reader.controls().panel, panel);
  assert.equal(reader.popup.children.length, 2);
  assert.equal(reader.doc.observers.size, 1);
  assert.equal(reader.controls().text.value, "second result");
  ui.disposeReaderPopups();
});

test("audio playback remains available and automatic playback occurs once per completed task", () => {
  const ui = mockPopup(undefined, { autoPlay: true });
  const reader = ui.reader();
  const translated = task("audio", "word", "success", "译文");
  translated.audio = [{ text: "word", url: "mock-audio-url" }];
  ui.buildReaderPopup(reader.event, translated);
  ui.updateReaderPopup();
  assert.deepEqual(ui.plays, ["mock-audio-url"]);
  reader.controls().audio.children[0].fire("click");
  assert.deepEqual(ui.plays, ["mock-audio-url", "mock-audio-url"]);
  ui.disposeReaderPopups();
});

test("manual add-to-note uses bound selection and preserves annotation metadata", async () => {
  const ui = mockPopup(undefined, { enableNote: true });
  const reader = ui.reader();
  ui.buildReaderPopup(
    reader.event,
    task("done", "real source", "success", "真实译文"),
  );
  reader.controls().addtonote.fire("click");
  await flush();
  assert.equal(ui.notes.length, 1);
  assert.equal(ui.notes[0][0].comment, "真实译文");
  assert.equal(ui.notes[0][0].text, "real source");
  assert.equal(ui.notes[0][0].color, "#ffd400");
  assert.equal(ui.translates.length, 0);
  ui.disposeReaderPopups();
});

test("detachment removes observer/UI but leaves the reusable reader task", async () => {
  const ui = mockPopup();
  const reader = ui.reader("reader");
  const pending = task("pending", "passage", "processing");
  ui.buildReaderPopup(reader.event, pending);
  reader.popup.remove();
  await flush();
  assert.equal(reader.doc.observers.size, 0);
  assert.equal(ui.bindings.canRender(pending.id, reader.popup), false);
  assert.equal(ui.bindings.findSame("reader", pending.raw, 1), pending);
  assert.equal(reader.popup.children.length, 1);
  ui.disposeReaderPopups();
});

test("reader unload and shutdown release every UI callback and binding", () => {
  const ui = mockPopup();
  const a = ui.reader("a"),
    b = ui.reader("b");
  const first = task("a", "one"),
    second = task("b", "two");
  ui.buildReaderPopup(a.event, first);
  ui.buildReaderPopup(b.event, second);
  a.doc.defaultView.fire("unload");
  assert.equal(ui.bindings.findSame("a", first.raw, 1), undefined);
  assert.equal(a.doc.observers.size, 0);
  assert.equal(ui.bindings.canRender(second.id, b.popup), true);
  ui.disposeReaderPopups();
  assert.equal(ui.bindings.canRender(second.id, b.popup), false);
  assert.equal(b.doc.observers.size, 0);
  assert.equal(b.popup.children.length, 1);
});

test("hidden popup releases its UI and disabled popup preference uses an actual hidden display", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  const selected = task("t", "passage");
  ui.buildReaderPopup(reader.event, selected);
  ui.prefs.enablePopup = false;
  ui.updateReaderPopup();
  assert.equal(reader.controls().panel.style.display, "none");
  reader.popup.hidden = true;
  ui.updateReaderPopup();
  assert.equal(reader.doc.observers.size, 0);
  assert.equal(ui.bindings.canRender(selected.id, reader.popup), false);
  assert.equal(reader.popup.children.length, 1);
  ui.disposeReaderPopups();
});

test("viewport constraints shift the popup inside small reader boundaries", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  reader.doc.documentElement.clientWidth = 300;
  reader.doc.documentElement.clientHeight = 250;
  ui.buildReaderPopup(reader.event, task("t", "passage"));
  const rect = reader.popup.getBoundingClientRect();
  assert.ok(rect.left >= 8 && rect.right <= 292);
  assert.ok(rect.top >= 8 && rect.bottom <= 242);
  ui.disposeReaderPopups();
});

test("changing source during processing cancels only that reader's old task", async () => {
  const pending = deferred();
  const ui = mockPopup(async () => pending.promise);
  const a = ui.reader("a"),
    b = ui.reader("b");
  const first = task("first", "one", "processing"),
    second = task("second", "two", "processing");
  ui.buildReaderPopup(a.event, first);
  ui.buildReaderPopup(b.event, second);
  assert.equal(a.controls().source.disabled, false);
  a.controls().source.value = "bing";
  a.controls().source.fire("change");
  assert.deepEqual(ui.invalidations, [first]);
  assert.equal(first.status, "fail");
  assert.equal(second.status, "processing");
  assert.equal(ui.bindings.getCurrentTask("a").service, "bing");
  assert.equal(ui.bindings.getCurrentTask("b"), second);
  pending.resolve();
  await flush();
  ui.disposeReaderPopups();
});

test("unload after temporary popup dismissal still cancels and releases its reader task", async () => {
  const ui = mockPopup();
  const reader = ui.reader("reader");
  const pending = task("pending", "passage", "processing");
  ui.buildReaderPopup(reader.event, pending);
  reader.popup.remove();
  await flush();
  assert.equal(ui.bindings.getCurrentTask("reader"), pending);
  reader.doc.defaultView.fire("unload");
  assert.deepEqual(ui.invalidations, [pending]);
  assert.equal(pending.status, "fail");
  assert.equal(ui.bindings.getCurrentTask("reader"), undefined);
  ui.disposeReaderPopups();
});

test("native content-window observer is bypassed and binding/rendering finish before chrome observation", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  const selected = task("initial-native", "synthetic passage");
  ui.buildReaderPopup(reader.event, selected);
  assert.equal(reader.doc.contentObserverAttempts, 0);
  assert.deepEqual(ui.observerSnapshots, [
    {
      taskId: selected.id,
      status: "等待翻译",
      width: "320px",
    },
  ]);
  assert.equal(reader.doc.observers.size, 1);
  assert.equal(reader.controls().source.value, "cnki");
  assert.ok(reader.controls().source.children.length > 0);
  ui.disposeReaderPopups();
});

test("observer failure leaves usable translation UI and still releases the reader on unload", async () => {
  const ui = mockPopup(undefined, { observerThrows: true });
  const reader = ui.reader("reader");
  const selected = task("native-failure", "synthetic passage");
  assert.doesNotThrow(() => ui.buildReaderPopup(reader.event, selected));
  assert.equal(reader.controls().status.textContent, "等待翻译");
  assert.equal(reader.popup.style.width, "320px");
  assert.equal(reader.doc.observers.size, 0);
  assert.equal(ui.logs.length, 1);
  assert.ok(!ui.logs[0].includes("SIMULATED_PRIVATE_ERROR"));
  reader.controls().translate.fire("click");
  await flush();
  assert.equal(reader.controls().status.textContent, "翻译完成");
  assert.equal(reader.controls().copy.disabled, false);
  reader.doc.defaultView.fire("unload");
  assert.equal(ui.bindings.getCurrentTask("reader"), undefined);
  assert.equal(reader.popup.children.length, 1);
  assert.equal(
    (reader.doc.defaultView.listeners.get("unload") || []).length,
    0,
  );
  ui.disposeReaderPopups();
});

test("native clearing custom children rebuilds a detached panel inside the same popup", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  ui.buildReaderPopup(
    reader.event,
    task("first", "first", "success", "first result"),
  );
  const previous = reader.controls();
  // Native CustomSections.replaceChildren removes the extension panel while
  // React reuses the selection-popup element and dispatches a fresh event.
  previous.panel.remove();
  const latest = task("second", "second", "success", "second result");
  ui.buildReaderPopup(reader.event, latest);
  const current = reader.controls();
  assert.notEqual(current.panel, previous.panel);
  assert.equal(current.text.value, latest.result);
  assert.equal(previous.text.value, "first result");
  assert.equal(ui.bindings.getForPopup(reader.popup).task, latest);
  assert.equal(reader.popup.children.length, 2);
  assert.equal(reader.popup.children[0], reader.colors);
  assert.equal(reader.doc.observers.size, 1);
  ui.disposeReaderPopups();
});

test("no current editor leaves add-to-note available and completed translation needs no extra request", async () => {
  const ui = mockPopup(undefined, { enableNote: true });
  const reader = ui.reader();
  const translated = task("ready", "source text", "success", "完成译文");
  ui.buildReaderPopup(reader.event, translated);
  assert.equal(reader.controls().addtonote.hidden, false);
  reader.controls().addtonote.fire("click");
  await flush();
  assert.equal(ui.translates.length, 0);
  assert.equal(ui.notes.length, 1);
  assert.equal(reader.controls().addtonote.textContent, "已加入笔记");
  assert.equal(reader.controls().addtonote.disabled, true);
  assert.match(ui.notifications[0].text, /已新建/);
  ui.disposeReaderPopups();
});

test("note busy state prevents double clicks and remains disabled through refresh", async () => {
  const gate = deferred();
  const ui = mockPopup(undefined, {
    enableNote: true,
    noteSaveGate: gate.promise,
  });
  const reader = ui.reader();
  ui.buildReaderPopup(reader.event, task("done", "source", "success", "译文"));
  reader.controls().addtonote.fire("click");
  assert.equal(reader.controls().addtonote.disabled, true);
  assert.equal(reader.controls().addtonote.textContent, "正在加入…");
  ui.updateReaderPopup();
  reader.controls().addtonote.fire("click");
  gate.resolve();
  await flush();
  assert.equal(ui.notes.length, 1);
  assert.equal(ui.notifications.length, 1);
  reader.controls().addtonote.fire("click");
  assert.equal(ui.notes.length, 1);
  ui.disposeReaderPopups();
});

test("note errors are visible, sanitized, and release busy state", async () => {
  const ui = mockPopup(undefined, {
    enableNote: true,
    noteSaveError: "DB error MOCK_PRIVATE_TOKEN",
  });
  const reader = ui.reader();
  const translated = {
    ...task("done", "source", "success", "译文"),
    secret: "MOCK_PRIVATE_TOKEN",
  };
  ui.buildReaderPopup(reader.event, translated);
  reader.controls().addtonote.fire("click");
  await flush();
  assert.equal(ui.notes.length, 0);
  assert.equal(reader.controls().addtonote.disabled, false);
  assert.match(ui.notifications[0].text, /加入笔记未完成/);
  assert.ok(!ui.notifications[0].text.includes("MOCK_PRIVATE_TOKEN"));
  assert.match(
    find(
      reader.popup,
      (element) => element.dataset.reliableRole === "note-feedback",
    ).textContent,
    /DB error/,
  );
  ui.disposeReaderPopups();
});

test("selection change while note translation waits cancels writing and does not leave new controls busy", async () => {
  const gate = deferred();
  const ui = mockPopup(
    async (pending) => {
      await gate.promise;
      pending.status = "success";
      pending.result = "late note translation";
    },
    { enableNote: true },
  );
  const reader = ui.reader();
  ui.buildReaderPopup(reader.event, task("waiting", "first source"));
  reader.controls().addtonote.fire("click");
  assert.equal(ui.translates.length, 1);
  ui.buildReaderPopup(
    reader.event,
    task("next", "next source", "success", "最新译文"),
  );
  gate.resolve();
  await flush();
  assert.equal(ui.notes.length, 0);
  assert.equal(reader.controls().text.value, "最新译文");
  assert.equal(reader.controls().addtonote.disabled, false);
  assert.equal(reader.controls().addtonote.textContent, "加入笔记");
  assert.match(ui.notifications[0].text, /已取消/);
  ui.disposeReaderPopups();
});
