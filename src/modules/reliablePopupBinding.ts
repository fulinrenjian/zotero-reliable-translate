import { ReliableSelectionBindings } from "../utils/reliableSelection";
import type { TranslateTask } from "../utils/task";
import { getPref } from "../utils/prefs";

export const popupBindings = new ReliableSelectionBindings<
  TranslateTask,
  HTMLDivElement
>();

const settingsAtSelection = new WeakMap<TranslateTask, string>();

export function rememberSelectionSettings(task: TranslateTask) {
  settingsAtSelection.set(task, selectionSettings());
}

export function selectionSettingsMatch(task: TranslateTask) {
  return settingsAtSelection.get(task) === selectionSettings();
}

function selectionSettings() {
  return JSON.stringify(
    [
      "translateSource",
      "dictSource",
      "enableDict",
      "sourceLanguage",
      "targetLanguage",
      "enableAutoDetectLanguage",
      "disabledLanguages",
    ].map((key) => getPref(key)),
  );
}

/** Choose the visible reader's task rather than another PDF's last request. */
export function getReaderForWindow(
  ownerWindow?: Window,
): _ZoteroTypes.ReaderInstance | undefined {
  let candidate = ownerWindow;
  for (let depth = 0; candidate && depth < 8; depth++) {
    const reader = Zotero.Reader._readers.find(
      (entry) =>
        entry._iframeWindow === candidate ||
        (!entry.tabID && entry._window === candidate),
    );
    if (reader) return reader;
    try {
      if (candidate.parent === candidate) break;
      candidate = candidate.parent;
    } catch {
      break;
    }
  }
  const mainWindow = Zotero.getMainWindow();
  return (
    Zotero.Reader.getByTabID(mainWindow.Zotero_Tabs.selectedID) || undefined
  );
}

export function getVisibleReaderTask(
  ownerWindow?: Window,
): TranslateTask | undefined {
  const reader = getReaderForWindow(ownerWindow);
  if (!reader) return undefined;
  const current = popupBindings.getCurrentTask(String(reader._instanceID));
  if (current) return current;
  const popup = addon.data.popup.currentPopup;
  const binding = popup ? popupBindings.getForPopup(popup) : undefined;
  if (binding && binding.itemId === reader.itemID) return binding.task;
  return addon.data.translate.queue.findLast(
    (task) => task.type === "text" && task.itemId === reader.itemID,
  );
}
