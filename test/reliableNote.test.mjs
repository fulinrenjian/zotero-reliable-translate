import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import {
  buildSelectionNoteHTML,
  escapeNoteHTML,
  getReaderNoteEditor,
  saveSelectionToNote,
} from "../src/modules/reliableNote.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (html) =>
  html
    .replace(/<br\s*\/?>|<\/(?:p|div|h[1-6]|blockquote)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

function item(
  id,
  {
    regular = false,
    parentID,
    deleted = false,
    editable = true,
    title = `item-${id}`,
    libraryID = 1,
  } = {},
) {
  return {
    id,
    key: `KEY${id}`,
    parentID,
    libraryID,
    deleted,
    isRegularItem: () => regular,
    isAttachment: () => !regular,
    isEditable: () => editable,
    getDisplayTitle: () => title,
  };
}

function fixture(options = {}) {
  const attachment = item(11, {
    parentID: options.standalone ? undefined : 22,
    title: "Attachment",
    ...options.attachment,
  });
  const parent = item(22, {
    regular: true,
    title: "Paper & source <title>",
    ...options.parent,
  });
  const created = [],
    persisted = [],
    opens = [],
    inserts = [],
    posts = [],
    serializations = [],
    editorSaves = [];
  let sourceCurrent = true;
  let editorData = {
    html: options.existingHTML || "<p>Existing note content</p>",
    state: {},
  };
  const editorItem = {
    ...item(77, { title: "Existing note", ...options.editorItem }),
    getNote: () =>
      editorItem.html || options.existingHTML || "<p>Existing note content</p>",
  };
  const runtime = {
    getItem: async (id) => {
      if (options.beforeGet) await options.beforeGet(id);
      return id === 11
        ? attachment
        : id === 22 && !options.missingParent
          ? parent
          : undefined;
    },
    getMainWindow: () => ({
      ZoteroContextPane: { activeEditor: options.mainEditor },
    }),
    getLibrary: () => ({ editable: options.libraryEditable !== false }),
    getItemURI: (source) => `http://zotero.example/items/${source.key}`,
    createNote: () => {
      const note = {
        ...item(0),
        setNote(html) {
          this.html = html;
        },
        async save() {},
      };
      created.push(note);
      return note;
    },
    saveNote: async (note, isCurrent) => {
      assert.equal(isCurrent(), true);
      if (options.beforeCommit) await options.beforeCommit(note);
      if (!isCurrent()) throw new Error("选区已变化，事务已回滚");
      if (options.saveError) throw new Error(options.saveError);
      note.id = 100 + persisted.length;
      persisted.push(note);
    },
    openNote: async (id) => {
      opens.push(id);
      if (options.openError) throw new Error("Opening failed");
    },
    serializeAnnotation: (annotation) => {
      serializations.push(annotation);
      return options.omitComment
        ? `<blockquote>${escapeNoteHTML(annotation.text)}</blockquote>`
        : `<blockquote>${escapeNoteHTML(annotation.text)}</blockquote><p>${escapeNoteHTML(annotation.comment)}</p>`;
    },
    htmlToText: textOf,
    readEditorData: () => (options.noEditorData ? null : { ...editorData }),
    saveEditor: async (instance, data) => {
      if (options.beforeEditorSave) await options.beforeEditorSave();
      if (options.editorSaveError) throw new Error(options.editorSaveError);
      editorSaves.push(data);
      if (!options.dontPersistEditor) editorItem.html = data.html;
    },
    confirmationTimeoutMs: 15,
  };
  const instance = {
    _item: editorItem,
    _readOnly: options.editorReadOnly || false,
    _initPromise: options.initPromise || Promise.resolve(),
    insertAnnotations: async (annotations) => {
      inserts.push(annotations);
      if (options.insertError) throw new Error(options.insertError);
      const apply = () => {
        if (!options.noDelivery)
          for (const annotation of annotations)
            editorData.html += runtime.serializeAnnotation(annotation);
      };
      if (options.beforeDelivery) await options.beforeDelivery(apply);
      else apply();
    },
    _postMessage: (message) => {
      posts.push(message);
      if (!options.noDelivery) {
        if (options.selectedHTML && message.pos !== -1) {
          // Model insertion at a selected editor range. A selected passage must
          // never be replaced or become the translation's insertion location.
          editorData.html = editorData.html.replace(
            options.selectedHTML,
            message.html,
          );
        } else editorData.html += message.html;
      }
    },
    focus() {
      if (options.focusError) throw new Error("Focus failed after saving");
    },
  };
  const editor = {
    mode: options.editorMode || "edit",
    item: editorItem,
    getCurrentInstance: () => instance,
  };
  const task = {
    id: "task",
    raw: options.raw || "Raw value 6.73 wt%? Na2SO3/NaOH!",
    result: options.result || "完整译文 6.73 wt%，保留 Na2SO3/NaOH。",
    status: "success",
  };
  const annotation = {
    id: "selection",
    type: options.annotationType || "highlight",
    pageLabel: options.noPage ? undefined : "iv",
    position: { pageIndex: 3, rects: [[1, 2, 3, 4]] },
    color: "#ffd400",
  };
  const reader = {
    itemID: 11,
    _window: {
      ZoteroContextPane: { activeEditor: options.editor ? editor : undefined },
    },
  };
  const input = { task, reader, annotation, isCurrent: () => sourceCurrent };
  return {
    input,
    runtime,
    parent,
    attachment,
    created,
    persisted,
    opens,
    inserts,
    posts,
    serializations,
    editorSaves,
    editorItem,
    editor,
    setCurrent: (current) => {
      sourceCurrent = current;
    },
  };
}

test("no editor creates a saved child note with escaped complete text and true source location", async () => {
  const f = fixture({
    raw: '<script>alert("x")</script> & original',
    result: "译文 <b>literal</b>",
  });
  const outcome = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(outcome.mode, "child");
  assert.equal(f.persisted.length, 1);
  const note = f.persisted[0];
  assert.equal(note.libraryID, 1);
  assert.equal(note.parentID, 22);
  assert.ok(note.html.includes("&lt;script&gt;"));
  assert.ok(!note.html.includes("<script>"));
  assert.ok(note.html.includes("译文 &lt;b&gt;literal&lt;/b&gt;"));
  assert.ok(note.html.includes("Paper &amp; source &lt;title&gt;，第 iv 页"));
  const metadata = JSON.parse(
    decodeURIComponent(note.html.match(/data-annotation="([^"]+)"/)[1]),
  );
  assert.deepEqual(metadata.position, f.input.annotation.position);
  assert.equal(metadata.pageLabel, "iv");
  assert.deepEqual(f.opens, [note.id]);
  assert.equal(outcome.noteID, note.id);
});

test("missing parent creates an independent note in the same library and says so", async () => {
  const f = fixture({ standalone: true, attachment: { libraryID: 9 } });
  const outcome = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(outcome.mode, "standalone");
  assert.equal(f.persisted[0].libraryID, 9);
  assert.equal(f.persisted[0].parentID, undefined);
  assert.match(outcome.message, /独立译文笔记/);
});

test("missing page label is marked missing and never inferred from a page index", () => {
  const f = fixture({ noPage: true });
  const html = buildSelectionNoteHTML({
    raw: f.input.task.raw,
    result: f.input.task.result,
    sourceTitle: "Paper",
    attachmentURI: "uri",
    annotation: f.input.annotation,
  });
  assert.ok(html.includes("页码未提供"));
  assert.ok(!html.includes("第 4 页"));
  assert.deepEqual(
    JSON.parse(decodeURIComponent(html.match(/data-annotation="([^"]+)"/)[1]))
      .position,
    f.input.annotation.position,
  );
});

test("current reader's editor is used rather than another window's editor", async () => {
  let wrongEditorCalls = 0;
  const f = fixture({
    editor: true,
    mainEditor: {
      getCurrentInstance: () => {
        wrongEditorCalls++;
        return {};
      },
    },
  });
  const outcome = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(outcome.mode, "appended");
  assert.equal(wrongEditorCalls, 0);
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.inserts, [[]]);
  assert.equal(f.serializations[0].text, f.input.task.raw);
  assert.ok(f.serializations[0].comment.includes(f.input.task.result));
  assert.equal(f.serializations[0].attachmentItemID, 11);
  assert.deepEqual(f.serializations[0].position, f.input.annotation.position);
  assert.equal(f.posts[0].pos, -1);
  assert.equal(outcome.noteID, 77);
  assert.equal(f.editorSaves.length, 1);
  assert.ok(f.editorItem.getNote().includes(f.input.task.result));
});

test("absence of an editor in the reader window does not append to an unrelated main-window note", async () => {
  let wrongEditorCalls = 0;
  const f = fixture({
    mainEditor: {
      getCurrentInstance: () => {
        wrongEditorCalls++;
        return {};
      },
    },
  });
  const outcome = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(outcome.mode, "child");
  assert.equal(wrongEditorCalls, 0);
});

test("readonly or deleted current editor is bypassed for a new editable source note", async () => {
  for (const flags of [
    { editorReadOnly: true },
    { editorItem: { deleted: true } },
    { editorMode: "view" },
  ]) {
    const f = fixture({ editor: true, ...flags });
    const outcome = await saveSelectionToNote(f.input, f.runtime);
    assert.equal(outcome.mode, "child");
    assert.equal(f.inserts.length, 0);
  }
});

test("an editor without ready document data falls back to a saved child note", async () => {
  const f = fixture({ editor: true, noEditorData: true });
  const result = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(result.mode, "child");
  assert.equal(f.inserts.length, 0);
  assert.equal(f.persisted.length, 1);
});

test("readonly library and deleted source prevent any note write", async () => {
  for (const flags of [
    { libraryEditable: false },
    { attachment: { deleted: true } },
    { parent: { deleted: true } },
    { parent: { editable: false } },
  ]) {
    const f = fixture(flags);
    await assert.rejects(saveSelectionToNote(f.input, f.runtime));
    assert.equal(f.created.length, 0);
    assert.equal(f.inserts.length, 0);
    assert.equal(f.persisted.length, 0);
  }
});

test("concurrent and subsequent clicks share the same completed write", async () => {
  const gate = deferred();
  const f = fixture({ beforeCommit: () => gate.promise });
  const one = saveSelectionToNote(f.input, f.runtime),
    two = saveSelectionToNote(f.input, f.runtime);
  gate.resolve();
  const [first, second] = await Promise.all([one, two]);
  assert.equal(first, second);
  assert.equal(f.created.length, 1);
  assert.equal(f.persisted.length, 1);
  assert.equal(await saveSelectionToNote(f.input, f.runtime), first);
  assert.equal(f.opens.length, 1);
});

test("selection change during source loading cancels before any editor or database write", async () => {
  const gate = deferred();
  const f = fixture({ beforeGet: () => gate.promise });
  const pending = saveSelectionToNote(f.input, f.runtime);
  f.setCurrent(false);
  gate.resolve();
  await assert.rejects(pending, /选区已变化/);
  assert.equal(f.created.length, 0);
  assert.equal(f.persisted.length, 0);
});

test("selection change during a save rolls back and a real save error allows retry", async () => {
  const gate = deferred();
  const f = fixture({ beforeCommit: () => gate.promise });
  const pending = saveSelectionToNote(f.input, f.runtime);
  await delay();
  f.setCurrent(false);
  gate.resolve();
  await assert.rejects(pending, /事务已回滚/);
  assert.equal(f.persisted.length, 0);
  assert.equal(f.opens.length, 0);
  f.setCurrent(true);
  const outcome = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(outcome.mode, "child");
  assert.equal(f.persisted.length, 1);
});

test("opening failure does not turn a committed save into failure or duplicate it", async () => {
  const f = fixture({ openError: true });
  const outcome = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(outcome.opened, false);
  assert.match(outcome.message, /笔记已保存/);
  await saveSelectionToNote(f.input, f.runtime);
  assert.equal(f.persisted.length, 1);
});

test("user templates that omit translation use complete HTML without changing those templates", async () => {
  const f = fixture({ editor: true, omitComment: true });
  const outcome = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(outcome.mode, "appended");
  assert.deepEqual(f.inserts, [[]]);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].action, "insertHTML");
  assert.equal(f.posts[0].pos, -1);
  assert.ok(f.posts[0].html.includes(f.input.task.result));
  assert.ok(f.posts[0].html.includes(f.input.task.raw));
  assert.ok(f.editorItem.getNote().includes(f.input.task.result));
});

test("success waits for persistence rather than only accepting an insertion command", async () => {
  const gate = deferred();
  const f = fixture({ editor: true, beforeEditorSave: () => gate.promise });
  let finished = false;
  const pending = saveSelectionToNote(f.input, f.runtime).then((value) => {
    finished = true;
    return value;
  });
  await delay();
  assert.equal(f.inserts.length, 1);
  assert.equal(finished, false);
  assert.ok(!f.editorItem.getNote().includes(f.input.task.result));
  gate.resolve();
  await pending;
  assert.equal(finished, true);
  assert.ok(f.editorItem.getNote().includes(f.input.task.result));
});

test("unconfirmed insertion never reports success or duplicates itself on repeated clicks", async () => {
  const f = fixture({ editor: true, dontPersistEditor: true });
  await assert.rejects(
    saveSelectionToNote(f.input, f.runtime),
    /未确认.*已保存/,
  );
  await assert.rejects(
    saveSelectionToNote(f.input, f.runtime),
    /未确认.*已保存/,
  );
  assert.equal(f.inserts.length, 1);
  assert.equal(f.persisted.length, 0);
});

test("identical older content must gain a new occurrence before confirmation", async () => {
  const raw = "Original paragraph",
    result = "翻译段落";
  const f = fixture({
    editor: true,
    raw,
    result,
    existingHTML: `<p>${raw} ${result}</p>`,
  });
  await saveSelectionToNote(f.input, f.runtime);
  assert.equal(f.editorSaves.length, 1);
  assert.equal(f.editorItem.getNote().split(result).length - 1, 2);
});

test("append targets the document end and preserves a selected passage, images, and existing formatting", async () => {
  const selectedHTML = "<p><strong>User selected passage</strong></p>";
  const existingHTML =
    "<h2>Existing title</h2>" +
    selectedHTML +
    '<p>Final paragraph</p><p><img src="zotero://attachment/KEEP"/></p>';
  const f = fixture({ editor: true, existingHTML, selectedHTML });
  const result = await saveSelectionToNote(f.input, f.runtime);
  assert.equal(result.mode, "appended");
  assert.deepEqual(f.inserts, [[]]);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].pos, -1);
  assert.ok(f.editorItem.getNote().startsWith(existingHTML));
  assert.ok(f.editorItem.getNote().endsWith(f.posts[0].html));
  assert.ok(f.editorItem.getNote().includes(selectedHTML));
  assert.ok(f.editorItem.getNote().includes('src="zotero://attachment/KEEP"'));
  assert.ok(f.editorItem.getNote().includes(f.input.task.result));
  await saveSelectionToNote(f.input, f.runtime);
  assert.equal(f.posts.length, 1);
});

test("a template omitting translation still appends a complete block after a selected passage", async () => {
  const selectedHTML = "<p>Keep this selected text</p>";
  const existingHTML = selectedHTML + "<p>Keep the end as well</p>";
  const f = fixture({
    editor: true,
    existingHTML,
    selectedHTML,
    omitComment: true,
  });
  await saveSelectionToNote(f.input, f.runtime);
  assert.equal(f.posts[0].pos, -1);
  assert.ok(f.editorItem.getNote().startsWith(existingHTML));
  assert.ok(f.posts[0].html.includes("<h3>原文</h3>"));
  assert.ok(f.posts[0].html.includes("<h3>译文</h3>"));
  assert.ok(f.posts[0].html.includes("第 iv 页"));
  assert.equal(f.editorSaves.length, 1);
});

test("empty or unfinished translations are rejected without extra translation or note writes", async () => {
  for (const status of ["waiting", "processing", "fail"]) {
    const f = fixture();
    f.input.task.status = status;
    await assert.rejects(saveSelectionToNote(f.input, f.runtime), /尚无完成/);
    assert.equal(f.created.length, 0);
  }
});

test("reader editor lookup uses main window only when reader has no owner window", () => {
  const main = {
    ZoteroContextPane: { activeEditor: { getCurrentInstance() {} } },
  };
  assert.equal(
    getReaderNoteEditor({}, main),
    main.ZoteroContextPane.activeEditor,
  );
  assert.equal(
    getReaderNoteEditor({ _window: { ZoteroContextPane: {} } }, main),
    undefined,
  );
});

const require = createRequire(import.meta.url);
const ts = require("typescript");
const nativeModuleCode = ts.transpileModule(
  readFileSync(
    new URL("../src/modules/reliableNote.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function loadNativeAdapter(zotero) {
  const exports = {};
  vm.runInNewContext(nativeModuleCode, {
    exports,
    Zotero: zotero,
    setTimeout,
    clearTimeout,
  });
  return exports;
}

test("native adapter saves within a transaction and opens only after commit", async () => {
  const f = fixture();
  const events = [];
  let inTransaction = false;
  const zotero = {
    Items: { getAsync: f.runtime.getItem },
    Libraries: { get: f.runtime.getLibrary },
    URI: { getItemURI: f.runtime.getItemURI },
    getMainWindow: f.runtime.getMainWindow,
    Item: class {
      constructor() {
        this.id = 0;
      }
      setNote(html) {
        this.html = html;
      }
      async save(options) {
        assert.equal(inTransaction, true);
        assert.equal(options.notifierData.autoSyncDelay, 15);
        events.push("save");
        this.id = 333;
      }
    },
    DB: {
      executeTransaction: async (callback) => {
        events.push("begin");
        inTransaction = true;
        await callback();
        inTransaction = false;
        events.push("commit");
      },
    },
    Notes: {
      AUTO_SYNC_DELAY: 15,
      open: async (id, location, options) => {
        assert.equal(inTransaction, false);
        assert.equal(id, 333);
        assert.equal(options.openInWindow, false);
        events.push("open");
      },
    },
  };
  const api = loadNativeAdapter(zotero);
  const result = await api.saveSelectionToNote(f.input);
  assert.equal(result.noteID, 333);
  assert.deepEqual(events, ["begin", "save", "commit", "open"]);
});

test("native editor adapter reads full state and awaits _save before checking stored note", async () => {
  const f = fixture();
  let live = { html: "<p>Existing content</p>", state: {} },
    stored = live.html;
  const readFlags = [],
    saveFlags = [],
    calls = [];
  const noteItem = { ...item(77), getNote: () => stored };
  const instance = {
    _item: noteItem,
    _readOnly: false,
    _initPromise: Promise.resolve(),
    _iframeWindow: {
      wrappedJSObject: {
        getDataSync: (flag) => {
          readFlags.push(flag);
          return live;
        },
      },
    },
    insertAnnotations: async (annotations) => {
      calls.push("ensure-note");
      assert.equal(annotations.length, 0);
    },
    _postMessage: (message) => {
      calls.push("insert");
      assert.equal(message.action, "insertHTML");
      assert.equal(message.pos, -1);
      live = { ...live, html: live.html + message.html };
    },
    _save: async (data, skipModified) => {
      calls.push("save");
      saveFlags.push(skipModified);
      await delay();
      stored = data.html;
    },
  };
  f.input.reader._window.ZoteroContextPane.activeEditor = {
    mode: "edit",
    item: noteItem,
    getCurrentInstance: () => instance,
  };
  const zotero = {
    Items: { getAsync: f.runtime.getItem },
    Libraries: { get: f.runtime.getLibrary },
    URI: { getItemURI: f.runtime.getItemURI },
    getMainWindow: () => ({
      DOMParser: class {
        parseFromString(html) {
          return { body: { textContent: textOf(html) } };
        }
      },
    }),
    EditorInstanceUtilities: {
      serializeAnnotations: (annotations) => ({
        html: annotations.map(f.runtime.serializeAnnotation).join(""),
      }),
    },
  };
  const result = await loadNativeAdapter(zotero).saveSelectionToNote(f.input);
  assert.equal(result.mode, "appended");
  assert.equal(result.noteID, 77);
  assert.deepEqual(calls, ["ensure-note", "insert", "save"]);
  assert.ok(readFlags.every((flag) => flag === false));
  assert.deepEqual(saveFlags, [false]);
  assert.ok(stored.includes(f.input.task.result));
});

function nativeReaderOpeningFixture(options = {}) {
  const f = fixture();
  const opens = [],
    pins = [],
    saves = [],
    appends = [];
  let savedNote, live;
  const owner = {
    Zotero_Tabs: { selectedID: options.selectedID || "reader-11" },
    DOMParser: class {
      parseFromString(html) {
        return { body: { textContent: textOf(html) } };
      }
    },
    ZoteroContextPane: {
      collapsed: true,
      activeEditor: null,
      context: {
        mode: "item",
        _getCurrentNotesContext: () => ({
          libraryID: 1,
          _setPinnedNote: (note) => {
            pins.push(note.id);
            if (options.pinError) throw new Error("Cannot pin in this pane");
            live = { html: note.html, state: {} };
            const instance = {
              _item: note,
              _initPromise: Promise.resolve(),
              _iframeWindow: {
                wrappedJSObject: { getDataSync: () => live },
              },
              insertAnnotations: async (annotations) => {
                assert.equal(annotations.length, 0);
              },
              _postMessage: (message) => {
                appends.push(message);
                assert.equal(message.pos, -1);
                live = { ...live, html: live.html + message.html };
              },
              _save: async (data) => {
                note.html = data.html;
                saves.push(note.id);
              },
            };
            owner.ZoteroContextPane.activeEditor = {
              mode: "edit",
              item: note,
              _initPromise: Promise.resolve(),
              getCurrentInstance: () => instance,
            };
          },
        }),
      },
    },
  };
  f.input.reader._window = owner;
  f.input.reader.tabID = "reader-11";
  const zotero = {
    Items: {
      getAsync: async (id) =>
        savedNote && savedNote.id === id
          ? savedNote
          : await f.runtime.getItem(id),
    },
    Libraries: { get: f.runtime.getLibrary },
    URI: { getItemURI: f.runtime.getItemURI },
    getMainWindow: () => owner,
    Item: class {
      constructor() {
        Object.assign(this, item(0));
        savedNote = this;
      }
      setNote(html) {
        this.html = html;
      }
      getNote() {
        return this.html;
      }
      async save() {
        this.id = 333;
        saves.push(this.id);
      }
    },
    DB: { executeTransaction: async (callback) => await callback() },
    Notes: {
      AUTO_SYNC_DELAY: 15,
      open: async (id) => opens.push(id),
    },
    EditorInstanceUtilities: {
      serializeAnnotations: (annotations) => ({
        html: annotations.map(f.runtime.serializeAnnotation).join(""),
      }),
    },
  };
  return {
    ...f,
    owner,
    opens,
    pins,
    saves,
    appends,
    api: loadNativeAdapter(zotero),
    getSavedNote: () => savedNote,
  };
}

test("native new note opens beside its source PDF and the next translation appends to that saved note", async () => {
  const f = nativeReaderOpeningFixture();
  const first = await f.api.saveSelectionToNote(f.input);
  assert.equal(first.mode, "child");
  assert.equal(first.opened, true);
  assert.deepEqual(f.pins, [333]);
  assert.deepEqual(f.opens, []);
  assert.equal(f.owner.Zotero_Tabs.selectedID, "reader-11");
  assert.equal(f.owner.ZoteroContextPane.context.mode, "notes");
  assert.equal(f.owner.ZoteroContextPane.collapsed, false);
  const initialHTML = f.getSavedNote().getNote();
  const secondInput = {
    ...f.input,
    task: {
      ...f.input.task,
      id: "task-2",
      raw: "Another English paragraph",
      result: "另一段中文译文",
    },
  };
  const second = await f.api.saveSelectionToNote(secondInput);
  assert.equal(second.mode, "appended");
  assert.equal(second.noteID, first.noteID);
  assert.equal(f.appends.length, 1);
  assert.ok(f.getSavedNote().getNote().startsWith(initialHTML));
  assert.ok(f.getSavedNote().getNote().includes(secondInput.task.result));
  assert.deepEqual(f.saves, [333, 333]);
});

test("native note opening avoids pinning to a different selected reader and uses a normal note tab", async () => {
  const f = nativeReaderOpeningFixture({ selectedID: "unrelated-reader" });
  const result = await f.api.saveSelectionToNote(f.input);
  assert.equal(result.mode, "child");
  assert.equal(result.opened, true);
  assert.deepEqual(f.pins, []);
  assert.deepEqual(f.opens, [333]);
  assert.ok(f.getSavedNote().getNote().includes(f.input.task.result));
});

test("failure of the native reader note pane falls back after the note is saved", async () => {
  const f = nativeReaderOpeningFixture({ pinError: true });
  const result = await f.api.saveSelectionToNote(f.input);
  assert.equal(result.noteID, 333);
  assert.equal(result.opened, true);
  assert.deepEqual(f.opens, [333]);
  assert.deepEqual(f.saves, [333]);
  assert.ok(f.getSavedNote().getNote().includes(f.input.task.result));
});
