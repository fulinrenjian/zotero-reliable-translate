import { getReaderForWindow } from "./reliablePopupBinding";

const concatKey = Zotero.isMac ? "Meta" : "Control";

export function registerShortcuts() {
  ztoolkit.Keyboard.register((ev, data) => {
    if (data.type === "keydown") {
      if (ev.key === concatKey) {
        addon.data.translate.concatKey = true;
      }
    }
    if (data.type === "keyup") {
      addon.data.translate.concatKey = false;
      if (data.keyboard?.equals("accel,T")) {
        const ownerWindow = ev.target?.ownerGlobal as Window | undefined;
        const isReaderWindow =
          ev.target?.ownerGlobal?.location?.href ===
          "chrome://zotero/content/reader.xhtml";
        if (isReaderWindow || getReaderForWindow(ownerWindow)) {
          addon.hooks.onShortcuts("reader", ownerWindow);
        } else {
          addon.hooks.onShortcuts(
            Zotero.getMainWindow().Zotero_Tabs.selectedType,
          );
        }
      }
    }
  });
}
