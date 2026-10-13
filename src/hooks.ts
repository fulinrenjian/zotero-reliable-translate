import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerPrefsScripts,
  registerPrefsWindow,
} from "./modules/preferenceWindow";
import {
  registerReaderTabPanel,
  updateReaderTabPanels,
} from "./modules/tabpanel";
import { buildReaderPopup, updateReaderPopup } from "./modules/popup";
import { registerNotify } from "./modules/notify";
import { registerReaderInitializer } from "./modules/reader";
import { getPref } from "./utils/prefs";
import {
  addTranslateAnnotationTask,
  addTranslateTask,
  addTranslateTitleTask,
  getLastTranslateTask,
  TranslateTask,
  invalidateAllTranslateTasks,
  invalidateTranslateTask,
} from "./utils/task";
import { setDefaultPrefSettings } from "./modules/defaultPrefs";
import Addon from "./addon";
import { registerMenu } from "./modules/menu";
import { registerExtraColumns } from "./modules/itemTree";
import { registerShortcuts } from "./modules/shortcuts";
import { registerItemPaneInfoRows } from "./modules/infoBox";
import { registerCustomFields } from "./modules/fields";
import { prepareReliableSetup } from "./modules/reliableSetup";
import { applyReliableSpeedUpgrade } from "./modules/reliableSpeedSetup";
import { cancelCnkiTokenWork, prewarmCnkiToken } from "./modules/services/cnki";
import {
  popupBindings,
  rememberSelectionSettings,
  selectionSettingsMatch,
  getVisibleReaderTask,
} from "./modules/reliablePopupBinding";
import {
  canReuseSelectionTask,
  normalizeSelectionText,
} from "./utils/reliableSelection";
import { disposeReaderPopups } from "./modules/popup";

let translationActivated = false;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  // TODO: Remove this after zotero#3387 is merged
  if (__env__ === "development") {
    // Keep in sync with the scripts/startup.mjs
    const loadDevToolWhen = `Plugin ${config.addonID} startup`;
    ztoolkit.log(loadDevToolWhen);
  }

  initLocale();

  const setup = await prepareReliableSetup();
  registerPrefsWindow();
  if (!setup.shouldActivate) return;
  translationActivated = true;

  setDefaultPrefSettings();
  applyReliableSpeedUpgrade();

  registerCustomFields();

  registerReaderInitializer();
  for (const reader of Zotero.Reader._readers) {
    void prewarmCnkiToken(
      reader,
      () => addon.data.alive && Zotero.Reader._readers.includes(reader),
    );
  }

  registerShortcuts();

  registerNotify(["item", "tab"]);

  registerExtraColumns();

  registerItemPaneInfoRows();

  registerReaderTabPanel();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

async function onMainWindowLoad(win: Window): Promise<void> {
  if (!translationActivated) return;
  await new Promise((resolve) => {
    if (win.document.readyState !== "complete") {
      win.document.addEventListener("readystatechange", () => {
        if (win.document.readyState === "complete") {
          resolve(void 0);
        }
      });
    }
    resolve(void 0);
  });

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  Services.scriptloader.loadSubScript(
    `chrome://${config.addonRef}/content/scripts/customElements.js`,
    win,
  );

  (win as any).MozXULElement.insertFTLIfNeeded(
    `${config.addonRef}-mainWindow.ftl`,
  );

  registerMenu();

  win.document.addEventListener("focusout", (ev) => {
    if (ev.target !== win.document) {
      return;
    }
    addon.data.translate.concatKey = false;
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  win.document
    .querySelector(`[href="${config.addonRef}-mainWindow.ftl"]`)
    ?.remove();
}

function onShutdown(): void {
  translationActivated = false;
  cancelCnkiTokenWork();
  invalidateAllTranslateTasks();
  disposeReaderPopups();
  popupBindings.clear();
  ztoolkit.unregisterAll();
  Zotero.getMainWindows().forEach((win) => {
    onMainWindowUnload(win);
  });
  // Remove addon object
  addon.data.alive = false;
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this function clear.
 */
function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (!translationActivated || !addon.data.alive) return;
  if (event === "add" && type === "item") {
    if (
      !getPref("enableAnnotationFromSyncTranslation") &&
      extraData?.skipAutoSync
    )
      return;
    const annotationItems = Zotero.Items.get(ids as number[]).filter((item) =>
      item.isAnnotation(),
    );
    if (annotationItems.length === 0) {
      return;
    }
    if (getPref("enableComment")) {
      addon.hooks.onTranslateInBatch(
        annotationItems
          .map((item) => addTranslateAnnotationTask(item.id))
          .filter((task) => task) as TranslateTask[],
        { noDisplay: true },
      );
    }
  } else if (type === "tab" && ["select", "add", "close"].includes(event)) {
    addon.data.translate.concatKey = false;
  } else {
    return;
  }
}

function onPrefsLoad(event: Event) {
  registerPrefsScripts((event.target as any).ownerGlobal);
}

function onShortcuts(type: string, ownerWindow?: Window) {
  if (!translationActivated || !addon.data.alive) return;
  switch (type) {
    case "library":
      {
        addon.hooks.onTranslateInBatch(
          Zotero.getActiveZoteroPane()
            .getSelectedItems(true)
            .map((id) => addTranslateTitleTask(id, true))
            .filter((task) => task) as TranslateTask[],
          { noDisplay: true, noCache: true },
        );
      }
      break;
    case "reader":
      {
        const task = getVisibleReaderTask(ownerWindow);
        if (task) {
          addon.hooks.onTranslate(task, {
            noCheckZoteroItemLanguage: true,
            noCache: true,
          });
        }
      }
      break;
    default:
      break;
  }
}

async function onTranslate(): Promise<void>;
async function onTranslate(
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(
  task: TranslateTask | undefined,
  options?: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(...data: any) {
  let task = undefined;
  let options = {};
  if (data.length === 1) {
    if (data[0].raw) {
      task = data[0];
    } else {
      options = data[0];
    }
  } else if (data.length === 2) {
    task = data[0];
    options = data[1];
  }
  task = task || getVisibleReaderTask() || getLastTranslateTask();
  // Repeated shortcut/button presses share the ongoing attempt.
  if (
    !addon.data.alive ||
    !translationActivated ||
    !task ||
    task.status === "processing"
  )
    return;
  try {
    await addon.data.translate.services.runTranslationTask(task, options);
  } catch (_error) {
    task.status = "fail";
    task.result = "翻译未完成，请点击重试或切换翻译源。";
    addon.hooks.onReaderPopupRefresh();
  }
}

async function onTranslateInBatch(
  tasks: TranslateTask[],
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"] = {},
) {
  for (const task of tasks) {
    await addon.hooks.onTranslate(task, options);
    await Zotero.Promise.delay(addon.data.translate.batchTaskDelay);
  }
}

function onReaderPopupShow(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const selection = addon.data.translate.selectedText;
  const readerKey = String(event.reader._instanceID);
  const current = popupBindings.getCurrentTask(readerKey);
  const same = popupBindings.findSame(
    readerKey,
    selection,
    event.reader.itemID,
  );
  const previous =
    same &&
    normalizeSelectionText(same.raw) === normalizeSelectionText(selection)
      ? same
      : undefined;
  const concat =
    addon.data.translate.concatCheckbox ||
    (getPref("enableConcatKey") && addon.data.translate.concatKey);
  const reuse =
    previous &&
    !concat &&
    selectionSettingsMatch(previous) &&
    (canReuseSelectionTask(previous) ||
      (previous.status === "waiting" && !getPref("enableAuto")));
  if (current?.status === "processing" && !reuse) {
    invalidateTranslateTask(current);
    current.status = "fail";
    current.result = "选区已更换，原请求已停止。重新选择或点击重试可再次翻译。";
  }
  const joined =
    concat && current && current.itemId === event.reader.itemID
      ? `${current.raw} ${selection}`
      : selection;
  let task = reuse
    ? previous
    : addTranslateTask(
        normalizeSelectionText(joined),
        event.reader.itemID,
        "text",
        undefined,
        { forceNew: true },
      );
  if (!task) return;
  if (!reuse) rememberSelectionSettings(task);
  buildReaderPopup(event, task);
  addon.hooks.onReaderPopupRefresh();
  if (!reuse && getPref("enableAuto")) {
    addon.hooks.onTranslate(task);
  }
}

function onReaderPopupRefresh() {
  updateReaderPopup();
}

function onReaderTabPanelRefresh() {
  updateReaderTabPanels();
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onNotify,
  onPrefsLoad,
  onShortcuts,
  onTranslate,
  onTranslateInBatch,
  onReaderPopupShow,
  onReaderPopupRefresh,
  onReaderTabPanelRefresh,
};
