import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { ReliableSelectionBindings } from "../src/utils/reliableSelection.ts";
import { getPopupPresentation } from "../src/utils/reliablePopupPresenter.ts";
import * as geometry from "../src/utils/reliablePopupGeometry.ts";

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
const layoutExports = {};
vm.runInNewContext(compile("../src/modules/reliablePopupLayout.ts"), {
  exports: layoutExports,
  require: (id) => {
    if (id.endsWith("/reliablePopupGeometry")) return geometry;
    throw new Error(`Unexpected layout dependency: ${id}`);
  },
});

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

// The mock models DOM ancestry, native transform coordinates, event dispatch and
// scroll state. It does not render fonts/paint or replace real Zotero UI testing.
class EventTargetMock {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, handler, options = false) {
    const capture =
      typeof options === "boolean" ? options : Boolean(options.capture);
    const handlers = this.listeners.get(type) || [];
    if (
      !handlers.some(
        (entry) => entry.handler === handler && entry.capture === capture,
      )
    )
      handlers.push({ handler, capture, options });
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler, options = false) {
    const capture =
      typeof options === "boolean" ? options : Boolean(options.capture);
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter(
        (entry) => entry.handler !== handler || entry.capture !== capture,
      ),
    );
  }
  eventPath() {
    return [this];
  }
  fire(type, detail = {}) {
    if (type === "click" && this.disabled) return;
    const event = {
      type,
      target: this,
      currentTarget: undefined,
      cancelable: true,
      defaultPrevented: false,
      propagationStopped: false,
      immediateStopped: false,
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      deltaY: 0,
      deltaMode: 0,
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediateStopped = true;
        this.propagationStopped = true;
      },
      preventDefault() {
        if (this.cancelable && !this.passive) this.defaultPrevented = true;
      },
      ...detail,
    };
    const path = this.eventPath();
    const invoke = (target, capture) => {
      event.currentTarget = target;
      for (const entry of [...(target.listeners.get(type) || [])]) {
        if (entry.capture !== capture) continue;
        event.passive =
          typeof entry.options === "object" && entry.options.passive;
        entry.handler(event);
        if (typeof entry.options === "object" && entry.options.once)
          target.removeEventListener(type, entry.handler, entry.options);
        if (event.immediateStopped) break;
      }
      event.passive = false;
    };
    for (const target of path.slice(1).reverse()) {
      invoke(target, true);
      if (event.propagationStopped) return event;
    }
    invoke(this, true);
    if (!event.immediateStopped) invoke(this, false);
    if (!event.propagationStopped)
      for (const target of path.slice(1)) {
        invoke(target, false);
        if (event.propagationStopped) break;
      }
    if (
      type === "wheel" &&
      !event.defaultPrevented &&
      this.tagName === "textarea"
    ) {
      const line = Number.parseFloat(
        this.ownerDocument.defaultView.getComputedStyle(this).lineHeight,
      );
      this.scrollTop += geometry.normalizeWheelDelta(
        event.deltaY,
        event.deltaMode,
        line,
        this.clientHeight,
      );
    }
    return event;
  }
}

function matches(element, selectors) {
  return selectors.split(",").some((selector) => {
    selector = selector.trim();
    if (selector.startsWith("."))
      return element.className.split(/\s+/).includes(selector.slice(1));
    return element.tagName === selector.toLowerCase();
  });
}

class Element extends EventTargetMock {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag;
    this.children = [];
    this.style = new Proxy(
      {},
      {
        set: (target, key, value) => {
          if (target[key] !== value) {
            target[key] = value;
            doc.notify({
              type: "attributes",
              target: this,
              attributeName: "style",
            });
          }
          return true;
        },
      },
    );
    this.dataset = {};
    this.attributes = {};
    this._value = "";
    this.valueSetCount = 0;
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.className = "";
    this._connected = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this._scrollTop = 0;
    this._scrollLeft = 0;
    this.capturedPointers = new Set();
  }
  get parentElement() {
    return this.parent instanceof Element ? this.parent : null;
  }
  get parentNode() {
    return this.parent || null;
  }
  eventPath() {
    const path = [this];
    let parent = this.parent;
    while (parent) {
      path.push(parent);
      parent = parent.parent;
    }
    if (path.includes(this.ownerDocument))
      path.push(this.ownerDocument.defaultView);
    return path;
  }
  closest(selectors) {
    for (
      let current = this;
      current instanceof Element;
      current = current.parentElement
    )
      if (matches(current, selectors)) return current;
    return null;
  }
  contains(node) {
    for (let current = node; current; current = current.parent)
      if (current === this) return true;
    return false;
  }
  setPointerCapture(pointerId) {
    this.capturedPointers.add(pointerId);
  }
  hasPointerCapture(pointerId) {
    return this.capturedPointers.has(pointerId);
  }
  releasePointerCapture(pointerId) {
    if (this.capturedPointers.delete(pointerId))
      this.fire("lostpointercapture", { pointerId });
  }
  get value() {
    return this._value;
  }
  set value(value) {
    this._value = String(value);
    this.valueSetCount++;
    this.selectionStart = this.selectionEnd = this._value.length;
    this._scrollTop = this._scrollLeft = 0;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  get scrollTop() {
    return Math.max(
      0,
      Math.min(this._scrollTop, this.scrollHeight - this.clientHeight),
    );
  }
  set scrollTop(value) {
    this._scrollTop = Math.max(
      0,
      Math.min(value, this.scrollHeight - this.clientHeight),
    );
  }
  get scrollLeft() {
    return Math.max(
      0,
      Math.min(this._scrollLeft, this.scrollWidth - this.clientWidth),
    );
  }
  set scrollLeft(value) {
    this._scrollLeft = Math.max(
      0,
      Math.min(value, this.scrollWidth - this.clientWidth),
    );
  }
  get scrollHeight() {
    if (this._scrollHeight !== undefined) return this._scrollHeight;
    if (this.tagName !== "textarea") return this.clientHeight;
    const columns = Math.max(1, Math.floor((this.clientWidth - 12) / 7));
    const rows = this.value
      .split("\n")
      .reduce(
        (count, line) => count + Math.max(1, Math.ceil(line.length / columns)),
        0,
      );
    return Math.max(this.clientHeight, rows * 21 + 12);
  }
  set scrollHeight(value) {
    this._scrollHeight = value;
  }
  get scrollWidth() {
    return this._scrollWidth ?? this.clientWidth;
  }
  set scrollWidth(value) {
    this._scrollWidth = value;
  }
  get clientWidth() {
    if (this._clientWidth !== undefined) return this._clientWidth;
    if (this.tagName === "textarea")
      return Math.max(
        0,
        (this.closest(".selection-popup")?.offsetWidth || 420) - 28,
      );
    return this.offsetWidth;
  }
  set clientWidth(value) {
    this._clientWidth = value;
  }
  get clientHeight() {
    if (this._clientHeight !== undefined) return this._clientHeight;
    if (this.tagName === "textarea")
      return Math.max(
        0,
        (this.closest(".selection-popup")?.offsetHeight || 360) -
          this.ownerDocument.fixedChromeHeight,
      );
    return this.offsetHeight;
  }
  set clientHeight(value) {
    this._clientHeight = value;
  }
  get offsetWidth() {
    if (this.fixedRect)
      return this.fixedRect.width / this.ownerDocument.scale.x;
    const width = Number.parseFloat(this.style.width);
    if (this.style.width?.endsWith("px")) return width;
    if (this.tagName === "html" || this.tagName === "body")
      return this.ownerDocument.viewport.width;
    return this.className === "selection-popup"
      ? 180
      : this.parentElement?.offsetWidth || 180;
  }
  get offsetHeight() {
    if (this.tagName === "textarea") return this.clientHeight;
    if (this.fixedRect)
      return this.fixedRect.height / this.ownerDocument.scale.y;
    const height = Number.parseFloat(this.style.height);
    if (this.style.height?.endsWith("px")) return height;
    if (this.tagName === "html" || this.tagName === "body")
      return this.ownerDocument.viewport.height;
    return this.className === "selection-popup"
      ? 220
      : this.parentElement?.offsetHeight || 26;
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
    this.ownerDocument.notify({ type: "childList", target: this });
  }
  remove() {
    const previousParent = this.parent;
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    this.parent = undefined;
    this.connect(false);
    this.ownerDocument.notify({
      type: "childList",
      target: previousParent || this,
    });
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
    this.ownerDocument.notify({
      type: "attributes",
      target: this,
      attributeName: key,
    });
  }
  getAttribute(key) {
    return this.attributes[key] ?? null;
  }
  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
  querySelector(selector) {
    return find(this, (element) => matches(element, selector));
  }
  get offsetLeft() {
    return Number.parseFloat(this.style.left || "0");
  }
  get offsetTop() {
    return Number.parseFloat(this.style.top || "0");
  }
  getBoundingClientRect() {
    if (this.fixedRect)
      return {
        ...this.fixedRect,
        right: this.fixedRect.left + this.fixedRect.width,
        bottom: this.fixedRect.top + this.fixedRect.height,
      };
    const scale = this.ownerDocument.scale;
    const parent = this.parentElement?.getBoundingClientRect() || {
      left: 0,
      top: 0,
    };
    const translate = this.style.transform?.match(
      /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/,
    );
    const left =
      parent.left + (this.offsetLeft + Number(translate?.[1] || 0)) * scale.x;
    const top =
      parent.top + (this.offsetTop + Number(translate?.[2] || 0)) * scale.y;
    const width = this.offsetWidth * scale.x,
      height = this.offsetHeight * scale.y;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
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
class Document extends EventTargetMock {
  constructor() {
    super();
    this.observers = new Set();
    this.frames = new Map();
    this.frameId = 0;
    this.viewport = { width: 1200, height: 800 };
    this.scale = { x: 1, y: 1 };
    this.fixedChromeHeight = 188;
    this.documentElement = new Element(this, "html");
    this.documentElement.parent = this;
    this.body = new Element(this, "body");
    this.documentElement.append(this.body);
    this.documentElement.connect(true);
    this.defaultView = new Element(this, "window");
    this.defaultView.requestAnimationFrame = (callback) => {
      const id = ++this.frameId;
      this.frames.set(id, callback);
      return id;
    };
    this.defaultView.cancelAnimationFrame = (id) => this.frames.delete(id);
    this.defaultView.getComputedStyle = (element) => {
      const value = element.style.lineHeight || "1.5";
      const line = value.endsWith("px")
        ? Number.parseFloat(value)
        : Number.parseFloat(value) *
          (Number.parseFloat(element.style.fontSize) || 14);
      return { lineHeight: `${line}px` };
    };
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
  flushAnimationFrames() {
    for (let turn = 0; this.frames.size && turn < 10; turn++) {
      const pending = [...this.frames.values()];
      this.frames.clear();
      for (const callback of pending) callback(0);
    }
    assert.equal(this.frames.size, 0, "layout scheduling must settle");
  }
  createElement(tag) {
    return new Element(this, tag);
  }
  querySelector(selector) {
    return this.body.querySelector(selector);
  }
  notify(record) {
    for (const observer of this.observers) {
      if (
        !observer.targets?.some(
          ({ target, options }) =>
            (target === record.target ||
              (options.subtree && target.contains(record.target))) &&
            options[record.type],
        )
      )
        continue;
      if (
        record.type === "attributes" &&
        !observer.targets.some(
          ({ target, options }) =>
            target === record.target &&
            (!options.attributeFilter ||
              options.attributeFilter.includes(record.attributeName)),
        )
      )
        continue;
      if (observer.pending) continue;
      observer.pending = true;
      queueMicrotask(() => {
        observer.pending = false;
        if (this.observers.has(observer)) observer.callback();
      });
    }
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
    keepPopupSize: true,
    "reliablePopup.width": 420,
    "reliablePopup.height": 360,
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
      this.targets = [];
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
      this.targets.push({ target, options });
      target.ownerDocument.observers.add(this);
    }
    disconnect() {
      for (const doc of this.documents) doc.observers.delete(this);
      this.documents.clear();
      this.targets = [];
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
      if (id === "./reliablePopupLayout") return layoutExports;
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
  function reader(key = "reader", itemID = 1, readerOptions = {}) {
    const doc = new Document();
    if (readerOptions.viewport) doc.viewport = { ...readerOptions.viewport };
    if (readerOptions.scale) doc.scale = { ...readerOptions.scale };
    if (readerOptions.fixedChromeHeight !== undefined)
      doc.fixedChromeHeight = readerOptions.fixedChromeHeight;
    if (readerOptions.animationFrames === false)
      doc.defaultView.requestAnimationFrame = undefined;
    const view = doc.createElement("div");
    view.className = readerOptions.secondary
      ? "secondary-view"
      : "primary-view";
    view.fixedRect = readerOptions.viewRect || {
      left: 0,
      top: 0,
      ...doc.viewport,
    };
    const popup = doc.createElement("div");
    popup.className = "selection-popup";
    popup.style.left = "0px";
    popup.style.top = "0px";
    popup.style.width = "180px";
    popup.style.height = "220px";
    popup.style.maxWidth = "198px";
    popup.style.transform = readerOptions.transform || "translate(100px, 50px)";
    const colors = doc.createElement("div");
    colors.className = "colors";
    const customSections = doc.createElement("div");
    customSections.className = "custom-sections";
    popup.append(colors, customSections);
    view.append(popup);
    doc.body.append(view);
    const event = {
      reader: {
        _instanceID: key,
        itemID,
        _addToNote: (annotations) => notes.push(annotations),
      },
      doc,
      params: { annotation: { text: "original annotation", color: "#ffd400" } },
      append: (element) => {
        const section = doc.createElement("div");
        section.className = "section";
        section.append(element);
        customSections.append(section);
      },
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
          "size-reset",
        ].map((role) => [
          role,
          find(popup, (element) => element.dataset.reliableRole === role),
        ]),
      );
    return {
      event,
      doc,
      popup,
      colors,
      view,
      customSections,
      controls,
      handles: () =>
        popup.children.filter((element) => element.dataset.reliableResize),
      rebuildSections: () => customSections.replaceChildren(),
    };
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

function startResize(reader, edge, pointerId = 13) {
  const handle = reader
    .handles()
    .find((element) => element.dataset.reliableResize === edge);
  assert.ok(handle, `${edge} resize handle must exist`);
  const rect = reader.popup.getBoundingClientRect();
  const clientX = edge.includes("w")
    ? rect.left
    : edge.includes("e")
      ? rect.right
      : rect.left + rect.width / 2;
  const clientY = edge.includes("n")
    ? rect.top
    : edge.includes("s")
      ? rect.bottom
      : rect.top + rect.height / 2;
  const event = handle.fire("pointerdown", {
    button: 0,
    pointerId,
    clientX,
    clientY,
  });
  assert.equal(event.defaultPrevented, true);
  assert.equal(handle.hasPointerCapture(pointerId), true);
  return { handle, pointerId, clientX, clientY };
}

function moveResize(reader, drag, dx, dy) {
  return reader.doc.fire("pointermove", {
    pointerId: drag.pointerId,
    clientX: drag.clientX + dx,
    clientY: drag.clientY + dy,
  });
}

function endResize(reader, drag) {
  reader.doc.fire("pointerup", { pointerId: drag.pointerId });
  assert.equal(drag.handle.hasPointerCapture(drag.pointerId), false);
}

function assertInside(rect, area) {
  assert.ok(rect.left >= area.left - 1e-8 && rect.top >= area.top - 1e-8);
  assert.ok(
    rect.right <= area.left + area.width + 1e-8 &&
      rect.bottom <= area.top + area.height + 1e-8,
  );
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
  assert.equal(reader.popup.style.width, "420px");
  assert.equal(reader.popup.style.height, "360px");
  assert.equal(reader.popup.style.maxWidth, "none");
  assert.equal(c.panel.style.maxHeight, "none");
  assert.equal(c.panel.style.overflow, "hidden");
  assert.equal(c.text.style.overflowY, "auto");
  assert.equal(c.text.style.resize, "none");
  assert.equal(c.panel.parentElement.parentElement, reader.customSections);
  assert.equal(reader.handles().length, 8);
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
  assert.equal(reader.popup.children.length, 10);
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
  assert.equal(reader.popup.children.length, 2);
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
  assert.equal(b.popup.children.length, 2);
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
  assert.equal(reader.popup.children.length, 2);
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
  assert.ok(rect.top >= 0 && rect.bottom <= 250);
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
      width: "420px",
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
  assert.equal(reader.popup.style.width, "420px");
  assert.equal(reader.doc.observers.size, 0);
  assert.equal(ui.logs.length, 1);
  assert.ok(!ui.logs[0].includes("SIMULATED_PRIVATE_ERROR"));
  reader.controls().translate.fire("click");
  await flush();
  assert.equal(reader.controls().status.textContent, "翻译完成");
  assert.equal(reader.controls().copy.disabled, false);
  reader.doc.defaultView.fire("unload");
  assert.equal(ui.bindings.getCurrentTask("reader"), undefined);
  assert.equal(reader.popup.children.length, 2);
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
  reader.rebuildSections();
  const latest = task("second", "second", "success", "second result");
  ui.buildReaderPopup(reader.event, latest);
  const current = reader.controls();
  assert.notEqual(current.panel, previous.panel);
  assert.equal(current.text.value, latest.result);
  assert.equal(previous.text.value, "first result");
  assert.equal(ui.bindings.getForPopup(reader.popup).task, latest);
  assert.equal(reader.popup.children.length, 10);
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

test("all eight actual handles resize their dragged sides and save CSS dimensions", () => {
  const expected = {
    n: [100, 75, 420, 335],
    ne: [100, 75, 450, 335],
    e: [100, 50, 450, 360],
    se: [100, 50, 450, 385],
    s: [100, 50, 420, 385],
    sw: [130, 50, 390, 385],
    w: [130, 50, 390, 360],
    nw: [130, 75, 390, 335],
  };
  for (const [edge, [left, top, width, height]] of Object.entries(expected)) {
    const ui = mockPopup();
    const reader = ui.reader();
    ui.buildReaderPopup(reader.event, task(edge, "synthetic source"));
    assert.deepEqual(
      reader
        .handles()
        .map((handle) => handle.dataset.reliableResize)
        .sort(),
      ["e", "n", "ne", "nw", "s", "se", "sw", "w"],
    );
    const nativeTransform = reader.popup.style.transform;
    const drag = startResize(reader, edge);
    assert.equal(moveResize(reader, drag, 30, 25).defaultPrevented, true);
    const rect = reader.popup.getBoundingClientRect();
    assert.deepEqual(
      [rect.left, rect.top, rect.width, rect.height],
      [left, top, width, height],
      edge,
    );
    endResize(reader, drag);
    assert.equal(ui.prefs["reliablePopup.width"], width);
    assert.equal(ui.prefs["reliablePopup.height"], height);
    assert.equal(reader.popup.style.transform, nativeTransform);
    assert.equal(reader.colors, reader.popup.children[0]);
    ui.disposeReaderPopups();
  }
});

test("corner resize survives new selection and native section reconstruction, and reset restores defaults", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  ui.buildReaderPopup(reader.event, task("first", "first source"));
  const drag = startResize(reader, "se");
  moveResize(reader, drag, 110, 80);
  endResize(reader, drag);
  assert.deepEqual(
    [reader.popup.offsetWidth, reader.popup.offsetHeight],
    [530, 440],
  );
  ui.buildReaderPopup(reader.event, task("next", "next source"));
  assert.deepEqual(
    [reader.popup.offsetWidth, reader.popup.offsetHeight],
    [530, 440],
  );
  reader.rebuildSections();
  ui.buildReaderPopup(reader.event, task("rebuilt", "rebuilt source"));
  assert.deepEqual(
    [reader.popup.offsetWidth, reader.popup.offsetHeight],
    [530, 440],
  );
  assert.equal(reader.handles().length, 8);
  reader.controls()["size-reset"].fire("click");
  assert.deepEqual(
    [reader.popup.offsetWidth, reader.popup.offsetHeight],
    [420, 360],
  );
  assert.deepEqual(
    [ui.prefs["reliablePopup.width"], ui.prefs["reliablePopup.height"]],
    [420, 360],
  );
  ui.disposeReaderPopups();
});

test("explicit size-memory opt-out permits resize without overwriting preferences", () => {
  const ui = mockPopup(undefined, {
    keepPopupSize: false,
    "reliablePopup.width": 650,
    "reliablePopup.height": 480,
  });
  const reader = ui.reader();
  ui.buildReaderPopup(reader.event, task("initial", "source"));
  assert.deepEqual(
    [reader.popup.offsetWidth, reader.popup.offsetHeight],
    [420, 360],
  );
  const drag = startResize(reader, "se");
  moveResize(reader, drag, 50, 40);
  endResize(reader, drag);
  assert.deepEqual(
    [reader.popup.offsetWidth, reader.popup.offsetHeight],
    [470, 400],
  );
  assert.equal(ui.prefWrites.length, 0);
  assert.deepEqual(
    [ui.prefs["reliablePopup.width"], ui.prefs["reliablePopup.height"]],
    [650, 480],
  );
  ui.disposeReaderPopups();
});

test("split-view offset and native transform stay within the reader's clipped iframe viewport", async () => {
  const ui = mockPopup();
  const reader = ui.reader("split", 1, {
    viewport: { width: 1280, height: 900 },
    secondary: true,
    viewRect: { left: 480, top: 90, width: 400, height: 500 },
    transform: "translate(330px, 200px)",
  });
  ui.buildReaderPopup(reader.event, task("split", "source"));
  assertInside(reader.popup.getBoundingClientRect(), reader.view.fixedRect);
  const nativeTransform = reader.popup.style.transform;
  const drag = startResize(reader, "nw");
  moveResize(reader, drag, -2000, -2000);
  endResize(reader, drag);
  assertInside(reader.popup.getBoundingClientRect(), reader.view.fixedRect);
  assert.equal(reader.popup.style.transform, nativeTransform);
  reader.doc.documentElement.clientWidth = 700;
  reader.doc.defaultView.fire("resize");
  reader.doc.flushAnimationFrames();
  assertInside(reader.popup.getBoundingClientRect(), {
    left: 480,
    top: 90,
    width: 220,
    height: 500,
  });
  await flush();
  reader.doc.flushAnimationFrames();
  ui.disposeReaderPopups();
});

test("scaled reader coordinates resize in screen pixels while preferences remain CSS pixels", () => {
  const ui = mockPopup();
  const reader = ui.reader("zoom", 1, {
    viewport: { width: 1600, height: 1200 },
    scale: { x: 2, y: 2 },
  });
  ui.buildReaderPopup(reader.event, task("zoom", "source"));
  assert.deepEqual(
    [
      reader.popup.getBoundingClientRect().width,
      reader.popup.getBoundingClientRect().height,
    ],
    [840, 720],
  );
  const drag = startResize(reader, "e");
  moveResize(reader, drag, 60, 0);
  endResize(reader, drag);
  assert.equal(reader.popup.getBoundingClientRect().width, 900);
  assert.equal(reader.popup.style.width, "450px");
  assert.equal(ui.prefs["reliablePopup.width"], 450);
  ui.disposeReaderPopups();
});

test("additional fixed rows increase minimum height to preserve the body", () => {
  const ui = mockPopup();
  const reader = ui.reader("extra", 1, { fixedChromeHeight: 260 });
  ui.buildReaderPopup(reader.event, task("extra", "source"));
  const drag = startResize(reader, "s");
  moveResize(reader, drag, 0, -2000);
  endResize(reader, drag);
  assert.equal(reader.popup.offsetHeight, 308);
  assert.equal(reader.controls().text.clientHeight, 48);
  assertInside(reader.popup.getBoundingClientRect(), reader.view.fixedRect);
  ui.disposeReaderPopups();
});

test("body wheel keeps native default mid-scroll, suppresses boundary chaining, and background wheel forwards once", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  ui.buildReaderPopup(
    reader.event,
    task("long", "source", "success", "long translated line ".repeat(1000)),
  );
  const text = reader.controls().text;
  let outsideWheels = 0;
  reader.doc.addEventListener("wheel", () => outsideWheels++);
  text.scrollTop = 100;
  const middle = text.fire("wheel", { deltaY: 0.125, deltaMode: 0 });
  assert.equal(middle.defaultPrevented, false);
  assert.equal(text.scrollTop, 100.125);
  assert.equal(outsideWheels, 0);
  text.scrollTop = 0;
  assert.equal(text.fire("wheel", { deltaY: -10 }).defaultPrevented, true);
  assert.equal(text.scrollTop, 0);
  text.scrollTop = text.scrollHeight;
  assert.equal(text.fire("wheel", { deltaY: 10 }).defaultPrevented, true);
  assert.equal(text.scrollTop, text.scrollHeight - text.clientHeight);
  text.scrollTop = 100;
  const background = reader
    .controls()
    .panel.fire("wheel", { deltaY: 2, deltaMode: 1 });
  assert.equal(background.defaultPrevented, true);
  assert.equal(text.scrollTop, 142);
  reader.controls().panel.fire("wheel", { deltaY: 1, deltaMode: 2 });
  assert.equal(text.scrollTop, 142 + text.clientHeight);
  const previous = text.scrollTop;
  reader.controls().source.fire("wheel", { deltaY: 30 });
  assert.equal(text.scrollTop, previous);
  assert.equal(outsideWheels, 0);
  ui.disposeReaderPopups();
});

test("status-only and streaming updates preserve middle scroll and selected copy text", () => {
  const ui = mockPopup();
  const reader = ui.reader();
  const current = task(
    "stream",
    "source",
    "processing",
    "Streaming partial text ".repeat(200),
  );
  ui.buildReaderPopup(reader.event, current);
  const text = reader.controls().text;
  text.scrollWidth = 2000;
  text.scrollTop = 75;
  text.scrollLeft = 50;
  text.setSelectionRange(3, 20);
  const selected = text.value.slice(3, 20),
    assignments = text.valueSetCount;
  ui.updateReaderPopup();
  assert.equal(text.valueSetCount, assignments);
  assert.equal(text.scrollTop, 75);
  assert.equal(text.scrollLeft, 50);
  current.result += " more translated words".repeat(40);
  ui.updateReaderPopup();
  assert.equal(text.scrollTop, 75);
  assert.equal(text.scrollLeft, 50);
  assert.deepEqual([text.selectionStart, text.selectionEnd], [3, 20]);
  text.fire("keydown", { key: "c", ctrlKey: true });
  assert.deepEqual(ui.copies, [selected]);
  assert.equal(text.scrollTop, 75);
  text.scrollTop = text.scrollHeight;
  current.result += " appended at the tail".repeat(100);
  ui.updateReaderPopup();
  assert.equal(text.scrollTop, text.scrollHeight - text.clientHeight);
  reader.controls().raw.fire("click");
  assert.equal(text.scrollTop, 0);
  assert.equal(text.scrollLeft, 0);
  ui.disposeReaderPopups();
});

test("dispose during drag releases capture, removes document listeners and frames, and restores native styles", async () => {
  const ui = mockPopup();
  const reader = ui.reader();
  const original = { ...reader.popup.style },
    colors = reader.colors;
  ui.buildReaderPopup(reader.event, task("drag", "source"));
  const panel = reader.controls().panel;
  const drag = startResize(reader, "se");
  moveResize(reader, drag, 50, 40);
  assert.equal((reader.doc.listeners.get("pointermove") || []).length, 1);
  assert.ok(reader.doc.frames.size > 0);
  ui.disposeReaderPopups();
  await flush();
  assert.equal(drag.handle.hasPointerCapture(drag.pointerId), false);
  assert.equal(reader.handles().length, 0);
  for (const type of ["pointermove", "pointerup", "pointercancel"])
    assert.equal((reader.doc.listeners.get(type) || []).length, 0);
  for (const type of ["resize", "blur"])
    assert.equal((reader.doc.defaultView.listeners.get(type) || []).length, 0);
  assert.equal((reader.popup.listeners.get("wheel") || []).length, 0);
  assert.equal(reader.doc.frames.size, 0);
  assert.equal(reader.doc.observers.size, 0);
  for (const key of ["left", "top", "width", "height", "maxWidth", "transform"])
    assert.equal(reader.popup.style[key], original[key]);
  assert.equal(panel.isConnected, false);
  assert.equal(reader.popup.children[0], colors);
  assert.equal(colors.style.flexShrink, "");
  reader.doc.fire("pointermove", {
    pointerId: drag.pointerId,
    clientX: 900,
    clientY: 900,
  });
  assert.equal(reader.popup.style.width, original.width);
});

test("lost pointer capture and pointer cancel finish a drag once, with a synchronous rAF fallback", () => {
  for (const finish of ["lostpointercapture", "pointercancel"]) {
    const ui = mockPopup();
    const reader = ui.reader("fallback", 1, { animationFrames: false });
    ui.buildReaderPopup(reader.event, task("fallback", "source"));
    const drag = startResize(reader, "e");
    moveResize(reader, drag, 40, 0);
    if (finish === "lostpointercapture")
      drag.handle.releasePointerCapture(drag.pointerId);
    else reader.doc.fire("pointercancel", { pointerId: drag.pointerId });
    assert.equal(drag.handle.hasPointerCapture(drag.pointerId), false);
    assert.equal(ui.prefs["reliablePopup.width"], 460);
    assert.equal(
      ui.prefWrites.filter(([key]) => key === "reliablePopup.width").length,
      1,
    );
    assert.equal(reader.doc.frames.size, 0);
    ui.disposeReaderPopups();
  }
});

test("native popup removal during drag cleans up without persisting an offline size", async () => {
  const ui = mockPopup();
  const reader = ui.reader();
  ui.buildReaderPopup(reader.event, task("offline-drag", "source"));
  const drag = startResize(reader, "se");
  moveResize(reader, drag, 60, 30);
  reader.popup.remove();
  await flush();
  assert.equal(drag.handle.hasPointerCapture(drag.pointerId), false);
  assert.equal(reader.handles().length, 0);
  assert.equal(reader.doc.frames.size, 0);
  assert.equal((reader.doc.listeners.get("pointermove") || []).length, 0);
  assert.equal(
    ui.prefWrites.filter(([key]) => key.startsWith("reliablePopup.")).length,
    0,
  );
  assert.deepEqual(
    [ui.prefs["reliablePopup.width"], ui.prefs["reliablePopup.height"]],
    [420, 360],
  );
  ui.disposeReaderPopups();
});
