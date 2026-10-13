import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import {
  addTranslateTask,
  invalidateTranslateTask,
  TranslateTask,
} from "../utils/task";
import { redactServiceError } from "../utils/reliableRun";
import {
  getPopupPresentation,
  PopupTextMode,
} from "../utils/reliablePopupPresenter";
import {
  popupBindings,
  rememberSelectionSettings,
} from "./reliablePopupBinding";
import { saveSelectionToNote } from "./reliableNote";

type ReaderEvent = _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">;

interface PopupView {
  popup: HTMLDivElement;
  panel: HTMLDivElement;
  readerKey: string;
  reader: ReaderEvent["reader"];
  annotation: ReaderEvent["params"]["annotation"];
  mode: PopupTextMode;
  rawButton: HTMLButtonElement;
  resultButton: HTMLButtonElement;
  status: HTMLSpanElement;
  text: HTMLTextAreaElement;
  translateButton: HTMLButtonElement;
  copyButton: HTMLButtonElement;
  source: HTMLSelectElement;
  noteButton: HTMLButtonElement;
  noteMessage: HTMLDivElement;
  noteBusy: boolean;
  noteFeedback: string;
  noteFeedbackTaskId: string;
  noteSavedTaskId: string;
  noteSavedResult: string;
  noteTranslationTask?: TranslateTask;
  audiobox: HTMLDivElement;
  audioSignature: string;
  autoplayTaskId: string;
  observer?: MutationObserver;
  originalWidth: string;
  originalMaxWidth: string;
  originalBoxSizing: string;
}

const views = new Map<HTMLDivElement, PopupView>();
const readerLifecycles = new Map<
  string,
  { doc: Document; onUnload: () => void }
>();

function applyStyles(
  element: HTMLElement,
  styles: Partial<CSSStyleDeclaration>,
) {
  Object.assign(element.style, styles);
}

function button(doc: Document, label: string, role: string) {
  const element = doc.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.dataset.reliableRole = role;
  applyStyles(element, {
    font: "inherit",
    fontSize: "12px",
    minHeight: "26px",
    padding: "3px 8px",
    border: "1px solid var(--color-border, #c7ccd2)",
    borderRadius: "5px",
    background: "var(--color-background, #fff)",
    color: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  });
  return element;
}

/** Refresh every live reader from its bound task, including concurrent streams. */
export function updateReaderPopup() {
  for (const view of [...views.values()]) {
    if (popupIsDismissed(view.popup)) {
      disposeView(view);
      continue;
    }
    const binding = popupBindings.getForPopup(view.popup);
    if (!binding) {
      disposeView(view);
      continue;
    }
    const task = binding.task;
    if (!popupBindings.canRender(task.id, view.popup)) continue;
    view.panel.hidden = getPref("enablePopup") === false;
    view.panel.style.display = view.panel.hidden ? "none" : "flex";
    if (view.panel.hidden) continue;

    const presentation = getPopupPresentation(task, view.mode, (text) =>
      redactServiceError(text, task.secret),
    );
    view.popup.setAttribute("translate-task-id", task.id);
    view.panel.dataset.translationStatus = presentation.status;
    view.status.textContent = presentation.statusLabel;
    view.status.style.color =
      presentation.status === "fail"
        ? "var(--color-accent-red, #a52a2a)"
        : "inherit";
    view.text.value = presentation.text;
    view.text.style.direction = (view.mode === "raw"
      ? task.langfrom
      : task.langto
    )
      ?.split("-")[0]
      .match(/^(ar|fa|he)$/)
      ? "rtl"
      : "ltr";
    view.rawButton.setAttribute("aria-pressed", String(view.mode === "raw"));
    view.resultButton.setAttribute(
      "aria-pressed",
      String(view.mode === "result"),
    );
    view.rawButton.style.fontWeight = view.mode === "raw" ? "600" : "400";
    view.resultButton.style.fontWeight = view.mode === "result" ? "600" : "400";

    updateSources(view, task);
    const unconfigured = addon.data.translate.services
      .getUnconfiguredServiceIds()
      .has(task.service);
    view.translateButton.textContent = presentation.translateLabel;
    view.translateButton.disabled =
      presentation.translateDisabled || unconfigured;
    view.translateButton.style.opacity = view.translateButton.disabled
      ? "0.55"
      : "1";
    view.translateButton.title = unconfigured
      ? "此翻译源需先配置，请选择可用翻译源或到插件设置中配置。"
      : "翻译当前选区；失败后可再次重试。";
    view.copyButton.disabled = presentation.copyDisabled;
    view.copyButton.style.opacity = view.copyButton.disabled ? "0.55" : "1";
    view.copyButton.title = presentation.copyDisabled
      ? "译文完成后可复制。"
      : "复制完整译文";

    const fontSize = Number(getPref("fontSize")) || 14;
    const lineHeight = Number(getPref("lineHeight")) || 1.5;
    view.text.style.fontSize = `${Math.max(11, Math.min(24, fontSize))}px`;
    view.text.style.lineHeight = String(lineHeight);
    if (view.noteFeedbackTaskId && view.noteFeedbackTaskId !== task.id) {
      view.noteFeedback = "";
      if (view.noteTranslationTask?.status === "processing") {
        invalidateTranslateTask(view.noteTranslationTask);
        view.noteTranslationTask.status = "fail";
        view.noteTranslationTask.result = "选区已变化，本次加入笔记已取消。";
      }
    }
    const noteSaved =
      view.noteSavedTaskId === task.id && view.noteSavedResult === task.result;
    view.noteButton.hidden = !getPref("enableNote");
    view.noteButton.disabled =
      view.noteBusy ||
      noteSaved ||
      presentation.translateDisabled ||
      (unconfigured && task.status !== "success");
    view.noteButton.textContent = view.noteBusy
      ? "正在加入…"
      : noteSaved
        ? "已加入笔记"
        : "加入笔记";
    view.noteButton.title =
      "写入原文、译文与来源；未打开可编辑笔记时自动新建文献子笔记。";
    view.noteMessage.textContent = view.noteFeedback;
    view.noteMessage.hidden = !view.noteFeedback;
    view.noteMessage.style.display = view.noteFeedback ? "block" : "none";
    updateAudio(view, task);
    constrainToViewport(view.popup);
  }
}

export function buildReaderPopup(event: ReaderEvent, task: TranslateTask) {
  const { reader, doc, append } = event;
  const popup = doc.querySelector(".selection-popup") as HTMLDivElement | null;
  if (!popup) return;
  const readerKey = String(reader._instanceID);
  for (const oldView of [...views.values()]) {
    if (oldView.readerKey === readerKey && oldView.popup !== popup)
      disposeView(oldView);
  }

  let view = views.get(popup);
  // Native CustomSections clears its children before firing the next event,
  // even when React keeps the outer popup DOM node.
  if (view && !view.panel.isConnected) {
    disposeView(view);
    view = undefined;
  }
  let needsWatch = false;
  if (!view) {
    view = createView(event, popup, readerKey);
    views.set(popup, view);
    append(view.panel);
    needsWatch = true;
  }
  view.reader = reader;
  view.annotation = event.params.annotation;
  view.mode = "result";
  popupBindings.bind(readerKey, task, popup);
  addon.data.popup.currentPopup = popup;
  applyStyles(popup, {
    width: "320px",
    maxWidth: "calc(100vw - 16px)",
    boxSizing: "border-box",
  });
  updateReaderPopup();
  // Core rendering and translation must not depend on optional observation.
  if (needsWatch && views.get(popup) === view) watchPopup(view);
}

function createView(
  event: ReaderEvent,
  popup: HTMLDivElement,
  readerKey: string,
): PopupView {
  const { doc, reader } = event;
  const panel = doc.createElement("div");
  panel.className = `${config.addonRef}-readerpopup`;
  panel.dataset.reliableRole = "panel";
  applyStyles(panel, {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    width: "100%",
    maxHeight: "240px",
    overflowY: "auto",
    overflowX: "hidden",
    padding: "8px 6px 6px",
    boxSizing: "border-box",
    fontFamily: "inherit",
    color: "inherit",
    borderTop: "1px solid var(--color-border, #d9dce1)",
  });
  // Keep PDF selection events inside the controls from dismissing the toolbar.
  for (const type of ["pointerdown", "pointerup", "mousedown", "click"]) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }

  const header = doc.createElement("div");
  applyStyles(header, { display: "flex", alignItems: "center", gap: "4px" });
  const rawButton = button(doc, "原文", "raw");
  const resultButton = button(doc, "译文", "result");
  const status = doc.createElement("span");
  status.dataset.reliableRole = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  applyStyles(status, {
    marginLeft: "auto",
    fontSize: "12px",
    whiteSpace: "nowrap",
  });
  header.append(rawButton, resultButton, status);

  const text = doc.createElement("textarea");
  text.dataset.reliableRole = "text";
  text.setAttribute("aria-label", "选区原文或译文");
  text.readOnly = true;
  text.spellcheck = false;
  text.rows = 4;
  applyStyles(text, {
    width: "100%",
    height: "96px",
    minHeight: "64px",
    maxHeight: "144px",
    resize: "vertical",
    overflow: "auto",
    padding: "6px",
    boxSizing: "border-box",
    border: "1px solid var(--color-border, #d9dce1)",
    borderRadius: "5px",
    background: "var(--color-background, #fff)",
    color: "inherit",
    fontFamily: "inherit",
  });

  const actions = doc.createElement("div");
  applyStyles(actions, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
  });
  const translateButton = button(doc, "翻译", "translate");
  const copyButton = button(doc, "复制译文", "copy");
  const noteButton = button(doc, "加入笔记", "addtonote");
  actions.append(translateButton, copyButton, noteButton);

  const sourceRow = doc.createElement("label");
  applyStyles(sourceRow, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
  });
  const sourceLabel = doc.createElement("span");
  sourceLabel.textContent = "翻译源";
  sourceLabel.style.whiteSpace = "nowrap";
  const source = doc.createElement("select");
  source.dataset.reliableRole = "source";
  source.setAttribute("aria-label", "翻译源");
  applyStyles(source, {
    width: "100%",
    minWidth: "0",
    flex: "1",
    minHeight: "26px",
    font: "inherit",
    background: "var(--color-background, #fff)",
    color: "inherit",
    border: "1px solid var(--color-border, #c7ccd2)",
    borderRadius: "5px",
    padding: "2px 4px",
  });
  sourceRow.append(sourceLabel, source);

  const audiobox = doc.createElement("div");
  audiobox.dataset.reliableRole = "audio";
  applyStyles(audiobox, { display: "flex", gap: "4px", flexWrap: "wrap" });
  const noteMessage = doc.createElement("div");
  noteMessage.dataset.reliableRole = "note-feedback";
  noteMessage.setAttribute("role", "status");
  noteMessage.setAttribute("aria-live", "polite");
  applyStyles(noteMessage, { fontSize: "12px", lineHeight: "1.4" });
  panel.append(header, text, actions, sourceRow, audiobox, noteMessage);

  const view: PopupView = {
    popup,
    panel,
    readerKey,
    reader,
    annotation: event.params.annotation,
    mode: "result",
    rawButton,
    resultButton,
    status,
    text,
    translateButton,
    copyButton,
    source,
    noteButton,
    noteMessage,
    noteBusy: false,
    noteFeedback: "",
    noteFeedbackTaskId: "",
    noteSavedTaskId: "",
    noteSavedResult: "",
    audiobox,
    audioSignature: "",
    autoplayTaskId: "",
    originalWidth: popup.style.width,
    originalMaxWidth: popup.style.maxWidth,
    originalBoxSizing: popup.style.boxSizing,
  };
  rawButton.addEventListener("click", () => {
    view.mode = "raw";
    updateReaderPopup();
  });
  resultButton.addEventListener("click", () => {
    view.mode = "result";
    updateReaderPopup();
  });
  translateButton.addEventListener("click", () => {
    void startNewAttempt(view);
  });
  source.addEventListener("change", () => {
    void startNewAttempt(view, source.value);
  });
  copyButton.addEventListener("click", () => {
    const task = popupBindings.getForPopup(popup)?.task;
    if (!task) return;
    const presentation = getPopupPresentation(task);
    if (presentation.copyDisabled) return;
    copyText(presentation.copyText);
  });
  text.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "a") text.select();
    else if (key === "c")
      copyText(text.value.slice(text.selectionStart, text.selectionEnd));
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  noteButton.addEventListener("click", () => {
    void addSelectionToNote(view);
  });
  return view;
}

function updateSources(view: PopupView, task: TranslateTask) {
  const services = addon.data.translate.services;
  const unavailable = services.getUnconfiguredServiceIds();
  const choices = services
    .getAllServices()
    .filter(
      (service) => service.type === "sentence" || service.id === task.service,
    );
  // Rebuild only when services/configuration/current word engine actually change.
  const signature = JSON.stringify(
    choices.map((service) => [
      service.id,
      services.getServiceNameByID(service.id),
      unavailable.has(service.id),
    ]),
  );
  if (view.source.dataset.optionsSignature !== signature) {
    view.source.replaceChildren();
    for (const service of choices) {
      const option = view.source.ownerDocument.createElement("option");
      option.value = service.id;
      option.disabled = unavailable.has(service.id);
      option.textContent = `${services.getServiceNameByID(service.id)}${option.disabled ? "（需配置）" : ""}`;
      view.source.append(option);
    }
    view.source.dataset.optionsSignature = signature;
  }
  view.source.value = task.service;
}

async function startNewAttempt(view: PopupView, nextServiceId?: string) {
  const binding = popupBindings.getForPopup(view.popup);
  if (!binding) return;
  const previous = binding.task;
  const sourceChanged =
    nextServiceId !== undefined && nextServiceId !== previous.service;
  if (
    (!sourceChanged && previous.status === "processing") ||
    (nextServiceId !== undefined && !sourceChanged)
  )
    return;
  const serviceId = nextServiceId || previous.service;
  const service = addon.data.translate.services.getServiceById(serviceId);
  if (
    !service ||
    addon.data.translate.services.getUnconfiguredServiceIds().has(serviceId)
  ) {
    updateReaderPopup();
    return;
  }
  if (sourceChanged)
    setPref(
      service.type === "word" ? "dictSource" : "translateSource",
      serviceId,
    );
  const task = addTranslateTask(
    previous.raw,
    previous.itemId,
    "text",
    serviceId,
  );
  if (!task) return;
  if (previous.status === "processing") {
    invalidateTranslateTask(previous);
    previous.status = "fail";
    previous.result = "翻译源已切换，原请求已取消。请选择当前翻译源继续翻译。";
  }
  popupBindings.bind(view.readerKey, task, view.popup);
  rememberSelectionSettings(task);
  view.mode = "result";
  const translation = addon.hooks.onTranslate(task, {
    noCache: true,
    noCheckZoteroItemLanguage: true,
  });
  updateReaderPopup();
  await translation;
  if (popupBindings.canRender(task.id, view.popup)) updateReaderPopup();
}

async function addSelectionToNote(view: PopupView) {
  const binding = popupBindings.getForPopup(view.popup);
  if (!binding || view.noteBusy) return;
  const boundTask = binding.task;
  if (
    view.noteSavedTaskId === boundTask.id &&
    view.noteSavedResult === boundTask.result
  )
    return;
  const isCurrent = () =>
    popupBindings.canRender(boundTask.id, view.popup, binding.generation);
  const reader = view.reader;
  const annotation = { ...view.annotation };
  view.noteBusy = true;
  view.noteFeedbackTaskId = boundTask.id;
  view.noteFeedback =
    boundTask.status === "success" ? "正在加入笔记…" : "正在翻译并加入笔记…";
  updateReaderPopup();
  try {
    if (boundTask.status === "processing")
      throw new Error("当前译文尚未完成，请稍候再加入笔记。");
    let translated = boundTask;
    if (boundTask.status !== "success") {
      const task = addTranslateTask(
        boundTask.raw,
        boundTask.itemId,
        "addtonote",
        boundTask.service,
      );
      if (!task) throw new Error("未能创建翻译任务，请重试。");
      view.noteTranslationTask = task;
      await addon.hooks.onTranslate(task, {
        noCheckZoteroItemLanguage: true,
        noDisplay: true,
        noCache: false,
      });
      translated = task;
    }
    if (!isCurrent())
      throw new Error("选区已变化或阅读器已关闭，本次加入笔记已取消。");
    if (translated.status !== "success" || !translated.result.trim())
      throw new Error(translated.result || "翻译尚未完成，请先重试翻译。");
    if (translated !== boundTask) {
      boundTask.result = translated.result;
      boundTask.status = "success";
      boundTask.service = translated.service;
      boundTask.langfrom = translated.langfrom;
      boundTask.langto = translated.langto;
      boundTask.audio = translated.audio;
      updateReaderPopup();
    }
    const result = await saveSelectionToNote({
      task: boundTask,
      reader,
      annotation,
      isCurrent,
    });
    view.noteSavedTaskId = boundTask.id;
    view.noteSavedResult = boundTask.result;
    view.noteFeedback = result.message;
    showNoteFeedback(result.message, false);
  } catch (error) {
    const message = `加入笔记未完成：${redactServiceError(String(error), boundTask.secret)}`;
    view.noteFeedback = message;
    showNoteFeedback(message, true);
  } finally {
    view.noteBusy = false;
    view.noteTranslationTask = undefined;
    if (views.get(view.popup) === view && view.popup.isConnected)
      updateReaderPopup();
  }
}

function showNoteFeedback(message: string, error: boolean) {
  new ztoolkit.ProgressWindow(error ? "加入笔记未完成" : "笔记已保存")
    .createLine({
      text: message,
      type: error ? "fail" : "success",
      progress: 100,
    })
    .show();
}

function copyText(text: string) {
  if (!text) return;
  new ztoolkit.Clipboard().addText(text, "text/plain").copy();
}

function updateAudio(view: PopupView, task: TranslateTask) {
  const shouldShow =
    task.status === "success" &&
    task.audio.length > 0 &&
    getPref("showPlayBtn");
  view.audiobox.hidden = !shouldShow;
  view.audiobox.style.display = shouldShow ? "flex" : "none";
  if (!shouldShow) return;
  const signature = `${task.id}:${JSON.stringify(task.audio)}`;
  const play = (url: string) => {
    const audio = new (ztoolkit.getGlobal("Audio"))(url);
    const result = audio.play();
    result?.catch(() => ztoolkit.log("音频播放失败"));
  };
  if (view.audioSignature !== signature) {
    view.audiobox.replaceChildren();
    for (const audio of task.audio) {
      const audioButton = button(
        view.popup.ownerDocument,
        `🔊 ${audio.text}`,
        "play",
      );
      audioButton.title = audio.text;
      audioButton.addEventListener("click", () => play(audio.url));
      view.audiobox.append(audioButton);
    }
    view.audioSignature = signature;
  }
  if (getPref("autoPlay") && view.autoplayTaskId !== task.id) {
    view.autoplayTaskId = task.id;
    play(task.audio[0].url);
  }
}

function constrainToViewport(popup: HTMLDivElement) {
  const doc = popup.ownerDocument;
  const width = doc.documentElement.clientWidth || doc.body.clientWidth;
  const height = doc.documentElement.clientHeight || doc.body.clientHeight;
  const rect = popup.getBoundingClientRect();
  if (!width || !height || !rect.width || !rect.height) return;
  const leftShift =
    rect.left < 8
      ? 8 - rect.left
      : rect.right > width - 8
        ? width - 8 - rect.right
        : 0;
  const topShift =
    rect.top < 8
      ? 8 - rect.top
      : rect.bottom > height - 8
        ? height - 8 - rect.bottom
        : 0;
  if (leftShift) popup.style.left = `${popup.offsetLeft + leftShift}px`;
  if (topShift) popup.style.top = `${popup.offsetTop + topShift}px`;
}

function watchPopup(view: PopupView) {
  try {
    // Register unload independently, so it survives an observer failure.
    watchReaderLifecycle(view.readerKey, view.popup.ownerDocument);
  } catch {
    ztoolkit.log("翻译浮窗阅读器生命周期监听未能初始化。");
  }
  try {
    // A content-window constructor sees sandbox option objects through Xrays
    // and may see every flag as false. The privileged chrome constructor can
    // observe reader DOM nodes while retaining the caller's option dictionary.
    const Observer = (
      Zotero.getMainWindow() as unknown as {
        MutationObserver: typeof MutationObserver;
      }
    ).MutationObserver;
    view.observer = new Observer(() => {
      if (popupIsDismissed(view.popup)) disposeView(view);
    });
    view.observer.observe(view.popup.ownerDocument.body, {
      childList: true,
      subtree: true,
    });
    view.observer.observe(view.popup, {
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "style"],
    });
  } catch {
    view.observer?.disconnect();
    view.observer = undefined;
    ztoolkit.log("翻译浮窗观察器未能初始化；将在刷新和阅读器关闭时清理。");
  }
}

function watchReaderLifecycle(readerKey: string, doc: Document) {
  const existing = readerLifecycles.get(readerKey);
  if (existing?.doc === doc) return;
  existing?.doc.defaultView?.removeEventListener("unload", existing.onUnload);
  const onUnload = () => {
    cancelReaderTask(readerKey);
    for (const view of [...views.values()]) {
      if (view.readerKey === readerKey) disposeView(view);
    }
    popupBindings.releaseReader(readerKey);
    doc.defaultView?.removeEventListener("unload", onUnload);
    readerLifecycles.delete(readerKey);
  };
  readerLifecycles.set(readerKey, { doc, onUnload });
  doc.defaultView?.addEventListener("unload", onUnload);
}

function disposeView(view: PopupView) {
  if (views.get(view.popup) !== view) return;
  if (view.noteTranslationTask?.status === "processing") {
    invalidateTranslateTask(view.noteTranslationTask);
    view.noteTranslationTask.status = "fail";
    view.noteTranslationTask.result = "浮窗已关闭，本次加入笔记的翻译已取消。";
  }
  view.observer?.disconnect();
  popupBindings.closePopup(view.popup);
  view.panel.remove();
  view.popup.style.width = view.originalWidth;
  view.popup.style.maxWidth = view.originalMaxWidth;
  view.popup.style.boxSizing = view.originalBoxSizing;
  views.delete(view.popup);
  if (addon.data.popup.currentPopup === view.popup)
    addon.data.popup.currentPopup = null;
}

function popupIsDismissed(popup: HTMLDivElement) {
  return (
    !popup.isConnected ||
    popup.hidden ||
    popup.style.display === "none" ||
    popup.getAttribute("aria-hidden") === "true"
  );
}

function cancelReaderTask(readerKey: string) {
  const task = popupBindings.getCurrentTask(readerKey);
  if (task?.status === "processing") {
    invalidateTranslateTask(task);
    task.status = "fail";
    task.result = "阅读器已关闭，原翻译请求已取消。重新打开选区后可重试。";
  }
}

/** Remove all observers, UI references and selection bindings on shutdown. */
export function disposeReaderPopups() {
  for (const view of [...views.values()]) {
    disposeView(view);
  }
  for (const [readerKey, lifecycle] of readerLifecycles) {
    cancelReaderTask(readerKey);
    lifecycle.doc.defaultView?.removeEventListener(
      "unload",
      lifecycle.onUnload,
    );
  }
  readerLifecycles.clear();
  popupBindings.clear();
}
