/** Note creation/append follows the installed Zotero 10 native implementation. */
export interface NoteItemLike {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number | false;
  deleted?: boolean;
  parentItem?: NoteItemLike;
  isRegularItem(): boolean;
  isAttachment?(): boolean;
  isEditable(): boolean;
  getDisplayTitle(): string;
  getNote?(): string;
}

export interface WritableNoteLike extends NoteItemLike {
  setNote(html: string): unknown;
  save(options?: object): Promise<unknown>;
}

export interface NoteEditorInstanceLike {
  _initPromise?: Promise<unknown>;
  _readOnly?: boolean;
  _item?: NoteItemLike;
  insertAnnotations(annotations: object[]): Promise<void>;
  focus?(): void;
  _postMessage?(message: object): void;
}

export interface NoteEditorLike {
  _initPromise?: Promise<unknown>;
  mode?: string;
  item?: NoteItemLike;
  getCurrentInstance(): NoteEditorInstanceLike | undefined | null;
}

export interface NoteOwnerWindow {
  ZoteroContextPane?: { activeEditor?: NoteEditorLike | null };
}

export interface NoteReaderLike {
  itemID?: number;
  tabID?: string;
  _window?: unknown;
}

export interface NoteAnnotationLike {
  id?: string;
  type?: string;
  pageLabel?: string;
  position?: unknown;
  color?: string;
}

export interface NoteTaskLike {
  id: string;
  raw: string;
  result: string;
  status: "waiting" | "processing" | "success" | "fail";
}

export interface SelectionNoteInput {
  task: NoteTaskLike;
  reader: NoteReaderLike;
  annotation: NoteAnnotationLike;
  /** Checked immediately before an insertion and inside a save transaction. */
  isCurrent: () => boolean;
}

export interface NoteSaveResult {
  mode: "appended" | "child" | "standalone";
  noteID?: number;
  opened: boolean;
  message: string;
}

export interface NoteRuntime {
  getItem(
    id: number,
  ): Promise<NoteItemLike | undefined> | NoteItemLike | undefined;
  getMainWindow(): NoteOwnerWindow;
  getLibrary(id: number): { editable: boolean } | undefined;
  getItemURI(item: NoteItemLike): string;
  createNote(): WritableNoteLike;
  /** Must roll back if isCurrent becomes false before the transaction commits. */
  saveNote(note: WritableNoteLike, isCurrent: () => boolean): Promise<void>;
  openNote(id: number): Promise<unknown>;
  serializeAnnotation(annotation: object): string;
  htmlToText(html: string): string;
  readEditorData(
    instance: NoteEditorInstanceLike,
  ): { html: string; state?: unknown } | null;
  saveEditor(
    instance: NoteEditorInstanceLike,
    data: { html: string; state?: unknown },
  ): Promise<void>;
  confirmationTimeoutMs?: number;
}

const writes = new WeakMap<
  object,
  { fingerprint: string; promise: Promise<NoteSaveResult> }
>();

class NoteInsertUnconfirmedError extends Error {}

export function escapeNoteHTML(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function ensureCurrent(isCurrent: () => boolean) {
  if (!isCurrent())
    throw new Error("选区已变化或阅读器已关闭，本次加入笔记已取消。");
}

export function getReaderNoteEditor(
  reader: NoteReaderLike,
  mainWindow: NoteOwnerWindow,
): NoteEditorLike | undefined {
  // A floating reader owns a different context pane from the main window.
  return (
    ((reader._window || mainWindow) as NoteOwnerWindow).ZoteroContextPane
      ?.activeEditor || undefined
  );
}

function noteIsEditable(item: NoteItemLike | undefined, runtime: NoteRuntime) {
  return Boolean(
    item &&
    !item.deleted &&
    !item.parentItem?.deleted &&
    item.isEditable() &&
    runtime.getLibrary(item.libraryID)?.editable,
  );
}

async function usableEditor(reader: NoteReaderLike, runtime: NoteRuntime) {
  const editor = getReaderNoteEditor(reader, runtime.getMainWindow());
  if (
    !editor ||
    typeof editor.getCurrentInstance !== "function" ||
    (editor.mode && editor.mode !== "edit")
  )
    return undefined;
  const instance = editor.getCurrentInstance();
  if (!instance) return undefined;
  if (instance._initPromise) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        instance._initPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("笔记编辑器尚未就绪。")),
            1500,
          );
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  if (
    instance._readOnly ||
    !noteIsEditable(instance._item || editor.item, runtime)
  )
    return undefined;
  if (!runtime.readEditorData(instance)) return undefined;
  return instance;
}

function clonePosition(position: unknown): unknown {
  return position === undefined
    ? undefined
    : JSON.parse(JSON.stringify(position));
}

/** Complete plain-text payload; source values are never inferred from a page index. */
export function buildSelectionNoteHTML(options: {
  raw: string;
  result: string;
  sourceTitle: string;
  attachmentURI: string;
  annotation: NoteAnnotationLike;
}): string {
  const { raw, result, sourceTitle, attachmentURI, annotation } = options;
  const page = annotation.pageLabel
    ? `，第 ${annotation.pageLabel} 页`
    : "（页码未提供）";
  const metadata = encodeURIComponent(
    JSON.stringify({
      attachmentURI,
      annotationKey: annotation.id,
      pageLabel: annotation.pageLabel,
      position: annotation.position,
      color: annotation.color,
    }),
  );
  const textHTML = (text: string) =>
    escapeNoteHTML(text).replace(/\r\n|\r|\n/g, "<br/>");
  const underline = annotation.type === "underline";
  return `<div data-schema-version="${underline ? 10 : 9}"><h2>划词译文</h2><p><strong>来源：</strong>${escapeNoteHTML(sourceTitle + page)}</p><h3>原文</h3><blockquote><p><span class="${underline ? "underline" : "highlight"}" data-annotation="${metadata}">${textHTML(raw)}</span></p></blockquote><h3>译文</h3><p>${textHTML(result)}</p></div>`;
}

/** Share one write for repeated clicks on the same unchanged translation task. */
export function saveSelectionToNote(
  input: SelectionNoteInput,
  runtime: NoteRuntime = nativeNoteRuntime(input.reader),
): Promise<NoteSaveResult> {
  ensureCurrent(input.isCurrent);
  if (
    input.task.status !== "success" ||
    !input.task.result.trim() ||
    !input.task.raw.trim()
  ) {
    return Promise.reject(
      new Error("尚无完成的译文，请先完成翻译再加入笔记。"),
    );
  }
  const annotation = {
    ...input.annotation,
    position: clonePosition(input.annotation.position),
  };
  const snapshot = { ...input, task: { ...input.task }, annotation };
  const fingerprint = JSON.stringify([
    input.reader.itemID,
    snapshot.task.raw,
    snapshot.task.result,
    annotation.pageLabel,
    annotation.position,
  ]);
  const existing = writes.get(input.task);
  if (existing?.fingerprint === fingerprint) return existing.promise;
  const promise = saveOnce(snapshot, runtime);
  writes.set(input.task, { fingerprint, promise });
  void promise.catch((error) => {
    // Once an insertion is dispatched, a retry must not duplicate it merely
    // because confirmation was slow. Other failures allow a fresh attempt.
    if (
      !(error instanceof NoteInsertUnconfirmedError) &&
      writes.get(input.task)?.promise === promise
    )
      writes.delete(input.task);
  });
  return promise;
}

async function saveOnce(
  input: SelectionNoteInput,
  runtime: NoteRuntime,
): Promise<NoteSaveResult> {
  const attachmentID = input.reader.itemID;
  if (!attachmentID) throw new Error("当前阅读器没有来源附件，无法加入笔记。");
  const attachment = await runtime.getItem(attachmentID);
  if (
    !attachment ||
    attachment.deleted ||
    (attachment.isAttachment && !attachment.isAttachment())
  ) {
    throw new Error("当前来源附件不存在或已删除，无法加入笔记。");
  }
  const parent = attachment.parentID
    ? await runtime.getItem(attachment.parentID)
    : undefined;
  if (parent?.deleted) throw new Error("当前文献已被删除，无法加入笔记。");
  ensureCurrent(input.isCurrent);
  const sourceTitle =
    (parent?.isRegularItem() ? parent : attachment).getDisplayTitle() || "文献";
  const page = input.annotation.pageLabel
    ? `，第 ${input.annotation.pageLabel} 页`
    : "（页码未提供）";
  const instance = await usableEditor(input.reader, runtime);
  ensureCurrent(input.isCurrent);
  if (instance) {
    const annotation = {
      ...input.annotation,
      type: input.annotation.type || "highlight",
      attachmentItemID: attachment.id,
      text: input.task.raw,
      comment: `译文：\n${input.task.result}\n\n来源：${sourceTitle}${page}`,
    };
    const completeHTML = buildSelectionNoteHTML({
      raw: input.task.raw,
      result: input.task.result,
      sourceTitle,
      attachmentURI: runtime.getItemURI(attachment),
      annotation: input.annotation,
    });
    await insertAndConfirm(
      instance,
      annotation,
      completeHTML,
      input,
      sourceTitle,
      runtime,
    );
    try {
      instance.focus?.();
    } catch {
      /* The content is already confirmed saved. */
    }
    return {
      mode: "appended",
      noteID: instance._item?.id,
      opened: true,
      message: "已加入并保存当前笔记。",
    };
  }
  if (!runtime.getLibrary(attachment.libraryID)?.editable) {
    throw new Error("当前文库为只读状态，无法新建译文笔记。");
  }
  const child = parent?.isRegularItem() ? parent : undefined;
  if (child && !child.isEditable())
    throw new Error("当前文献不可编辑，无法新建子笔记。");
  const note = runtime.createNote();
  note.libraryID = attachment.libraryID;
  if (child) note.parentID = child.id;
  note.setNote(
    buildSelectionNoteHTML({
      raw: input.task.raw,
      result: input.task.result,
      sourceTitle,
      attachmentURI: runtime.getItemURI(attachment),
      annotation: input.annotation,
    }),
  );
  ensureCurrent(input.isCurrent);
  await runtime.saveNote(note, input.isCurrent);
  if (!note.id) throw new Error("笔记保存未完成，请稍后重试。");
  let opened = false;
  try {
    await runtime.openNote(note.id);
    opened = true;
  } catch {
    /* Saved note remains valid if opening the UI fails. */
  }
  const message = child
    ? "已新建当前文献的译文笔记。"
    : "当前附件没有普通父条目，已在同一文库新建独立译文笔记。";
  return {
    mode: child ? "child" : "standalone",
    noteID: note.id,
    opened,
    message: message + (opened ? "" : "笔记已保存，可在文库中查看。"),
  };
}

function normalizeNoteText(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function occurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0,
    start = 0;
  while ((start = haystack.indexOf(needle, start)) !== -1) {
    count++;
    start += needle.length;
  }
  return count;
}

async function insertAndConfirm(
  instance: NoteEditorInstanceLike,
  annotation: object,
  completeHTML: string,
  input: SelectionNoteInput,
  sourceTitle: string,
  runtime: NoteRuntime,
) {
  const currentData = runtime.readEditorData(instance);
  if (!currentData) throw new Error("当前笔记编辑器尚未就绪，请稍后重试。");
  const baseline = normalizeNoteText(runtime.htmlToText(currentData.html));
  const raw = normalizeNoteText(input.task.raw),
    result = normalizeNoteText(input.task.result);
  const required = [raw, result, normalizeNoteText(sourceTitle)];
  const nativeHTML = runtime.serializeAnnotation(annotation);
  const nativeText = normalizeNoteText(runtime.htmlToText(nativeHTML));
  if (!instance._postMessage)
    throw new Error("当前笔记编辑器不支持安全追加，请稍后重试。");
  ensureCurrent(input.isCurrent);
  // insertAnnotations([]) only ensures an unsaved native editor has a note.
  // Calling it with content uses pos:null, which depends on the current editor
  // selection. Zotero 10.0.6's bundled note-editor insertHTML explicitly treats
  // every negative integer position as doc.content.size at delivery time.
  // This preserves all existing content even if the user selected a passage.
  await instance.insertAnnotations([]);
  ensureCurrent(input.isCurrent);
  instance._postMessage({
    action: "insertHTML",
    pos: -1,
    // User templates can omit {{comment}}. Keep complete templates, otherwise
    // append our complete source + translation block without changing settings.
    html: required.every((text) => nativeText.includes(text))
      ? nativeHTML
      : completeHTML,
  });
  const deadline = Date.now() + (runtime.confirmationTimeoutMs ?? 2000);
  while (Date.now() <= deadline) {
    const data = runtime.readEditorData(instance);
    const text = data ? normalizeNoteText(runtime.htmlToText(data.html)) : "";
    const inserted =
      data &&
      [raw, result].every(
        (part) => occurrences(text, part) > occurrences(baseline, part),
      ) &&
      text.includes(normalizeNoteText(sourceTitle));
    if (inserted) {
      if (!input.isCurrent())
        throw new NoteInsertUnconfirmedError(
          "选区已变化；插入请求已发送，请查看当前笔记，避免重复加入。",
        );
      try {
        await runtime.saveEditor(instance, data);
      } catch (error) {
        throw new NoteInsertUnconfirmedError(
          `已插入内容，但保存确认失败。请查看当前笔记，避免重复加入。原始错误：${String(error)}`,
        );
      }
      const persisted = instance._item?.getNote?.();
      const savedText = normalizeNoteText(runtime.htmlToText(persisted || ""));
      if (
        [raw, result].every(
          (part) => occurrences(savedText, part) > occurrences(baseline, part),
        )
      )
        return;
      throw new NoteInsertUnconfirmedError(
        "已发送插入请求，但未确认笔记已保存。请查看当前笔记，避免重复加入。",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new NoteInsertUnconfirmedError(
    "已发送插入请求，但暂未确认保存。请查看当前笔记，避免重复加入。",
  );
}

interface NativeNoteOwnerWindow extends NoteOwnerWindow {
  Zotero_Tabs?: { selectedID: string };
  ZoteroContextPane?: {
    activeEditor?: NoteEditorLike | null;
    collapsed?: boolean;
    context?: {
      mode: string;
      _getCurrentNotesContext?(): {
        libraryID: number;
        _setPinnedNote?(item: NoteItemLike): void;
      };
    };
  };
}

async function openSavedNote(id: number, reader: NoteReaderLike) {
  try {
    const owner = (reader._window ||
      Zotero.getMainWindow()) as NativeNoteOwnerWindow;
    // _setPinnedNote uses the selected tab to bind a child note to its reader.
    // Floating readers have no tabID/context pane and use the safe tab fallback.
    if (!reader.tabID || owner.Zotero_Tabs?.selectedID !== reader.tabID)
      throw new Error("Source reader is not the selected tab");
    const pane = owner.ZoteroContextPane;
    const context = pane?.context;
    const notes = context?._getCurrentNotesContext?.();
    const note = (await Zotero.Items.getAsync(id)) as NoteItemLike;
    if (
      !context ||
      !notes?._setPinnedNote ||
      !note ||
      notes.libraryID !== note.libraryID ||
      owner.Zotero_Tabs?.selectedID !== reader.tabID
    )
      throw new Error("Reader note context is unavailable");
    // These are the installed contextPane/notesContext paths used by native
    // notes-list clicks and new-note creation. Keep the PDF selected and pin the
    // saved note beside it so the next selection can append to the same note.
    context.mode = "notes";
    pane!.collapsed = false;
    notes._setPinnedNote(note);
    const editor = pane!.activeEditor;
    if (!editor || editor.item?.id !== id)
      throw new Error("Reader note editor did not open");
    if (editor._initPromise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          editor._initPromise,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Reader note editor timed out")),
              2000,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return;
  } catch {
    // Already-saved notes remain valid if an unavailable/changed reader context
    // requires opening in Zotero's normal note tab instead.
  }
  return Zotero.Notes.open(id, undefined, { openInWindow: false });
}

function nativeNoteRuntime(reader: NoteReaderLike): NoteRuntime {
  return {
    getItem: async (id) => (await Zotero.Items.getAsync(id)) || undefined,
    // Bundled types mislabel activeEditor as EditorInstance; native source
    // returns the note-editor component with getCurrentInstance().
    getMainWindow: () => Zotero.getMainWindow() as unknown as NoteOwnerWindow,
    getLibrary: (id) => Zotero.Libraries.get(id) || undefined,
    getItemURI: (item) => Zotero.URI.getItemURI(item as Zotero.Item),
    createNote: () => new Zotero.Item("note"),
    saveNote: async (note, isCurrent) => {
      // Native EditorInstance._save uses this same transaction + item.save path.
      await Zotero.DB.executeTransaction(async () => {
        ensureCurrent(isCurrent);
        await note.save({
          notifierData: { autoSyncDelay: Zotero.Notes.AUTO_SYNC_DELAY },
        });
        ensureCurrent(isCurrent);
      });
    },
    openNote: (id) => openSavedNote(id, reader),
    serializeAnnotation: (annotation) =>
      Zotero.EditorInstanceUtilities.serializeAnnotations([annotation]).html,
    htmlToText: (html) => {
      const Parser = (
        Zotero.getMainWindow() as unknown as { DOMParser: typeof DOMParser }
      ).DOMParser;
      return (
        new Parser().parseFromString(
          html.replace(/<br\s*\/?>|<\/(?:p|div|h[1-6]|blockquote)>/gi, " "),
          "text/html",
        ).body.textContent || ""
      );
    },
    readEditorData: (instance) => {
      try {
        const window = (instance as unknown as Zotero.EditorInstance)
          ._iframeWindow;
        const data = window?.wrappedJSObject?.getDataSync(false);
        return data && typeof data.html === "string"
          ? JSON.parse(JSON.stringify(data))
          : null;
      } catch {
        return null;
      }
    },
    saveEditor: (instance, data) =>
      (instance as unknown as Zotero.EditorInstance)._save(data, false),
  };
}
