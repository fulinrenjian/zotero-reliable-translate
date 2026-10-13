import { config } from "../../package.json";
import { PluginCEBase } from "./base";
import { getPref, setPref } from "../utils/prefs";
import { LANG_CODE } from "../utils/config";
import {
  addTranslateTask,
  autoDetectLanguage,
  getLastTranslateTask,
  invalidateTranslateTask,
  TranslateTask,
} from "../utils/task";
import type { TranslationServices } from "../modules/services";
import { popupBindings } from "../modules/reliablePopupBinding";

export class TranslatorPanel extends PluginCEBase {
  _item: Zotero.Item | null = null;

  _taskID = "";
  private readerKey?: string;
  private readerItemID?: number;
  private selectionTaskID = "";
  private ownedTask?: TranslateTask;

  private get services(): TranslationServices {
    // Resolve the current addon instance instead of capturing the first
    // instance in a custom element constructor that may survive a hot reload.
    return this._addon.data.translate.services;
  }

  setReaderContext(readerKey?: string, itemID?: number): void {
    if (this.readerKey !== readerKey || this.readerItemID !== itemID) {
      this.ownedTask = undefined;
      this._taskID = "";
      this.selectionTaskID = "";
    }
    this.readerKey = readerKey;
    this.readerItemID = itemID;
  }

  /** Standalone windows adopt a task once; subsequent global tasks cannot steal it. */
  adoptTask(task?: TranslateTask): void {
    this.ownedTask = task;
    this._taskID = task?.id || "";
  }

  /** Reader selections can replace manual text only when this reader selects anew. */
  getTask(): TranslateTask | undefined {
    const selection = this.readerKey
      ? popupBindings.getCurrentTask(this.readerKey)
      : undefined;
    if (selection && selection.id !== this.selectionTaskID) {
      this.selectionTaskID = selection.id;
      this.adoptTask(selection);
    }
    return (
      this.ownedTask ||
      (this._taskID ? getLastTranslateTask({ id: this._taskID }) : undefined)
    );
  }

  private replaceTask(
    raw: string,
    service?: string,
  ): TranslateTask | undefined {
    const previous = this.getTask();
    const task = addTranslateTask(
      raw || " ",
      this.readerItemID ?? this.item?.id,
      "text",
      service || previous?.service || String(getPref("translateSource")),
    );
    if (!task) return undefined;
    task.raw = raw;
    task.langfrom =
      (this._queryID("langfrom") as XUL.MenuList)?.value ||
      String(getPref("sourceLanguage"));
    task.langto =
      (this._queryID("langto") as XUL.MenuList)?.value ||
      String(getPref("targetLanguage"));
    if (previous?.status === "processing") {
      invalidateTranslateTask(previous);
      previous.status = "fail";
      previous.result = "文本或翻译设置已更新，请使用当前任务继续翻译。";
    }
    this.adoptTask(task);
    return task;
  }

  private setManualResult(value: string): void {
    const task = this.getTask() || this.replaceTask("");
    if (!task) return;
    if (task.status === "processing") invalidateTranslateTask(task);
    task.result = value;
    task.status = value.trim() ? "success" : "waiting";
    task.processed = true;
  }

  get item() {
    return this._item;
  }

  set item(val) {
    this._item = val;
  }

  get content() {
    return this._parseContentID(
      MozXULElement.parseXULToFragment(`
<linkset>
  <html:link rel="localization" href="${config.addonRef}-panel.ftl" />
  <html:link
    rel="stylesheet"
    href="chrome://${config.addonRef}/content/styles/panel.css"
  ></html:link>
</linkset>
<hbox id="engine" align="center">
  <menulist id="services" native="true">
    <menupopup>
      ${this.services
        .getAllServices()
        .map((service) => {
          const customName = this.services.getServiceNameByID(service.id);
          return `<menuitem label="${customName}" value="${service.id}" />`;
        })
        .join("\n")}
    </menupopup>
  </menulist>
  <button id="translate" data-l10n-id="translate" />
</hbox>
<hbox id="language" align="center">
  <menulist id="langfrom" class="lang-menulist" native="true">
    <menupopup>
      ${LANG_CODE.map((lang) => `<menuitem label="${lang.name}" value="${lang.code}" />`).join("\n")}
    </menupopup>
  </menulist>
  <toolbarbutton id="swap-language" class="icon-button" data-l10n-id="swapLanguage" />
  <menulist id="langto" class="lang-menulist" native="true">
    <menupopup>
      ${LANG_CODE.map((lang) => `<menuitem label="${lang.name}" value="${lang.code}" />`).join("\n")}
    </menupopup>
  </menulist>
</hbox>
<html:div class="separator"></html:div>
<html:div id="text-container" class="editor-container">
  ${
    (getPref("enableMathRendering") as boolean)
      ? `<${config.addonRef}-math-textbox id="raw-text"></${config.addonRef}-math-textbox>`
      : `<editable-text id="raw-text" multiline="true" />`
  }
  <html:div id="resizer" class="draggable-container">
    <html:div class="separator"></html:div>
  </html:div>
  ${
    (getPref("enableMathRendering") as boolean)
      ? `<${config.addonRef}-math-textbox id="result-text"></${config.addonRef}-math-textbox>`
      : `<editable-text id="result-text" multiline="true" />`
  }
</html:div>
<html:div class="separator"></html:div>
<html:div class="options-container">
  <html:div id="auto-container" class="options-grid">
    <html:label class="options-label" data-l10n-id="auto" />
    <html:div class="options-content">
      <checkbox id="auto-trans-selection" native="true" data-l10n-id="autoTranslateSelection" />
      <checkbox id="auto-trans-annotation" native="true" data-l10n-id="autoTranslateAnnotation" />
    </html:div>
  </html:div>
  <html:div id="concat-container" class="options-grid">
    <html:label class="options-label" data-l10n-id="selection" />
    <html:div class="options-content">
      <checkbox id="concat" native="true" data-l10n-id="enableConcat" />
      <button id="clear-concat" data-l10n-id="clearConcat" />
    </html:div>
  </html:div>
  <html:div id="copy-container" class="options-grid" >
    <html:label class="options-label" data-l10n-id="copy" />
    <html:div class="options-content">
      <button id="copy-raw" data-l10n-id="copyRaw" />
      <button id="copy-result" data-l10n-id="copyResult" />
      <button id="copy-both" data-l10n-id="copyBoth" />
    </html:div>
  </html:div>
</html:div>
`),
    );
  }

  init(): void {
    // Services
    this._queryID("services")?.addEventListener("command", (e) => {
      const newService = (e.target as XUL.MenuList).value;
      setPref(
        this.services.getServiceById(newService)?.type === "word"
          ? "dictSource"
          : "translateSource",
        newService,
      );
      const previous = this.getTask();
      if (!previous) return;
      const task = this.replaceTask(previous.raw, newService);
      if (!task?.raw.trim()) return;
      this._addon.hooks.onTranslate(task, {
        noCheckZoteroItemLanguage: true,
        noCache: true,
      });
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    // Translate
    this._queryID("translate")?.addEventListener("command", () => {
      const raw =
        (
          this._queryID(
            getPref("rawResultOrder") ? "result-text" : "raw-text",
          ) as HTMLTextAreaElement
        )?.value || "";
      let task = this.getTask();
      if (task?.status === "processing" && task.raw === raw) return;
      if (!task || task.raw !== raw || task.processed)
        task = this.replaceTask(raw);
      if (!task?.raw.trim() || task.status === "processing") return;
      this._addon.hooks.onTranslate(task, {
        noCheckZoteroItemLanguage: true,
        noCache: true,
      });
    });

    // Language change
    this._queryID("langfrom")?.addEventListener("command", (e) => {
      const newValue = (e.target as XUL.MenuList).value;
      setPref("sourceLanguage", newValue);
      const itemID = this.readerItemID ?? this.item?.id;
      if (itemID) {
        this._addon.data.translate.cachedSourceLanguage[Number(itemID)] =
          newValue;
      }
      const task = this.getTask();
      if (task) this.replaceTask(task.raw);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    this._queryID("swap-language")?.addEventListener("command", () => {
      const langfrom = getPref("sourceLanguage") as string;
      const langto = getPref("targetLanguage") as string;
      setPref("targetLanguage", langfrom);
      setPref("sourceLanguage", langto);
      (this._queryID("langfrom") as XUL.MenuList).value = langto;
      (this._queryID("langto") as XUL.MenuList).value = langfrom;
      const task = this.getTask();
      if (task) this.replaceTask(task.raw);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    this._queryID("langto")?.addEventListener("command", (e) => {
      setPref("targetLanguage", (e.target as XUL.MenuList).value);
      const task = this.getTask();
      if (task) this.replaceTask(task.raw);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    // Text change
    this._queryID("raw-text")?.addEventListener("input", (e) => {
      const reverseRawResult = getPref("rawResultOrder");
      if (!reverseRawResult) {
        this.replaceTask((e.target as HTMLTextAreaElement).value);
      } else {
        this.setManualResult((e.target as HTMLTextAreaElement).value);
      }
    });

    this._queryID("result-text")?.addEventListener("input", (e) => {
      const reverseRawResult = getPref("rawResultOrder");
      if (!reverseRawResult) {
        this.setManualResult((e.target as HTMLTextAreaElement).value);
      } else {
        this.replaceTask((e.target as HTMLTextAreaElement).value);
      }
    });

    // Auto translate
    this._queryID("auto-trans-selection")?.addEventListener("command", (e) => {
      setPref("enableAuto", (e.target as XUL.Checkbox).checked);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    this._queryID("auto-trans-annotation")?.addEventListener("command", (e) => {
      setPref("enableComment", (e.target as XUL.Checkbox).checked);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    // Concat
    this._queryID("concat")?.addEventListener("command", (e) => {
      this._addon.data.translate.concatCheckbox = (
        e.target as XUL.Checkbox
      ).checked;
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    this._queryID("clear-concat")?.addEventListener("command", () => {
      this.replaceTask("");
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    // Copy
    this._queryID("copy-raw")?.addEventListener("command", () => {
      const task = this.getTask();
      if (!task) {
        return;
      }
      new this._addon.data.ztoolkit.Clipboard()
        .addText(task.raw, "text/plain")
        .copy();
    });

    this._queryID("copy-result")?.addEventListener("command", () => {
      const task = this.getTask();
      if (!task) {
        return;
      }
      new this._addon.data.ztoolkit.Clipboard()
        .addText(task.result, "text/plain")
        .copy();
    });

    this._queryID("copy-both")?.addEventListener("command", () => {
      const task = this.getTask();
      if (!task) {
        return;
      }
      new this._addon.data.ztoolkit.Clipboard()
        .addText(`${task.raw}\n----\n${task.result}`, "text/plain")
        .copy();
    });

    // Draggable text area
    const resizer = this._queryID("resizer") as HTMLElement;
    const container = this._queryID("text-container") as HTMLElement;
    const rawArea = this._queryID("raw-text") as HTMLElement;
    const resultArea = this._queryID("result-text") as HTMLElement;

    rawArea.style.flex = `${getPref("customRawRatio")} 1 0%`;
    resultArea.style.flex = `${getPref("customResultRatio")} 1 0%`;

    let isDragging = false;
    let containerRect: DOMRect;
    resizer?.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) {
        return;
      }
      isDragging = true;
      e.preventDefault();
      containerRect = container.getBoundingClientRect();
      window.document.addEventListener("mousemove", doDrag);
      window.document.addEventListener("mouseup", (e: MouseEvent) => {
        isDragging = false;
        window.document.removeEventListener("mousemove", doDrag);
      });
    });

    function doDrag(e: MouseEvent) {
      if (!isDragging) {
        return;
      }
      const newRawHeight = e.clientY - containerRect.top;
      const maxRawHeight = containerRect.height - 100 - 13;
      if (newRawHeight >= 100 && newRawHeight <= maxRawHeight) {
        const newResultHeight = containerRect.height - newRawHeight - 13;
        const newRawRatio = (
          newRawHeight / Math.min(newRawHeight, newResultHeight)
        ).toFixed(3);
        const newResultRatio = (
          newResultHeight / Math.min(newRawHeight, newResultHeight)
        ).toFixed(3);
        rawArea.style.flex = `${newRawRatio} 1 0%`;
        resultArea.style.flex = `${newResultRatio} 1 0%`;
        setPref("customRawRatio", newRawRatio);
        setPref("customResultRatio", newResultRatio);
      }
    }

    resizer?.addEventListener("dblclick", (e: MouseEvent) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      rawArea.style.flex = "1 1 0%";
      resultArea.style.flex = "1 1 0%";
      setPref("customRawRatio", "1");
      setPref("customResultRatio", "1");
    });
  }

  destroy(): void {}

  /**
   * Filter unconfigured services from the dropdown menu.
   * Hides services that require API keys but haven't been configured.
   */
  _filterUnconfiguredServices() {
    const menuPopup = this._queryID("services")?.querySelector("menupopup");
    if (!menuPopup) return;

    const menuItems = menuPopup.querySelectorAll("menuitem");
    const hideUnconfigured = getPref("hideUnconfiguredServices") as boolean;
    const unconfiguredIds = hideUnconfigured
      ? this.services.getUnconfiguredServiceIds()
      : null;

    menuItems.forEach((item) => {
      const serviceId = item.getAttribute("value");
      (item as HTMLElement).hidden = !!unconfiguredIds?.has(serviceId || "");
    });
  }

  render() {
    const updateHidden = (type: string, pref: string) => {
      const elem = this._queryID(type) as XUL.Box;
      const hidden = !getPref(pref) as boolean;
      elem.hidden = hidden;
      if (
        elem.nextElementSibling?.classList.contains("separator") ||
        elem.nextElementSibling?.classList.contains("draggable-container")
      ) {
        (elem.nextElementSibling as HTMLDivElement).hidden = hidden;
      }
    };
    const setCheckBox = (type: string, checked: boolean) => {
      const elem = this._queryID(type) as XUL.Checkbox;
      elem.checked = checked;
    };
    const setValue = (type: string, value: string) => {
      const elem = this._queryID(type) as XUL.Textbox;
      elem.value = value;
    };
    const setPalceHolder = (type: string, placeholder: string) => {
      const elem = this._queryID(type) as XUL.Textbox;
      elem.placeholder = placeholder;
    };
    const setTextBoxStyle = (type: string) => {
      const elem = this._queryID(type) as XUL.Textbox;
      elem.style.fontSize = `${getPref("fontSize")}px`;
      elem.style.lineHeight = getPref("lineHeight") as string;
    };

    updateHidden("engine", "showSidebarEngine");
    updateHidden("language", "showSidebarLanguage");
    updateHidden("raw-text", "showSidebarRaw");
    updateHidden("auto-container", "showSidebarSettings");
    updateHidden("concat-container", "showSidebarConcat");
    updateHidden("copy-container", "showSidebarCopy");

    // Filter unconfigured services from dropdown if preference is enabled
    this._filterUnconfiguredServices();

    const lastTask = this.getTask();
    setValue(
      "services",
      lastTask?.service || String(getPref("translateSource")),
    );

    const { fromLanguage, toLanguage } = autoDetectLanguage(this.item);
    setValue("langfrom", lastTask?.langfrom || fromLanguage);
    setValue("langto", lastTask?.langto || toLanguage);

    setCheckBox("auto-trans-selection", getPref("enableAuto") as boolean);
    setCheckBox("auto-trans-annotation", getPref("enableComment") as boolean);
    setCheckBox("concat", this._addon.data.translate.concatCheckbox);

    setTextBoxStyle("raw-text");
    setTextBoxStyle("result-text");
    const reverseRawResult = getPref("rawResultOrder");
    setPalceHolder(
      "raw-text",
      reverseRawResult ? "" : "Select or type to translate",
    );
    setPalceHolder(
      "result-text",
      reverseRawResult ? "Select or type to translate" : "",
    );

    if (!lastTask) {
      setValue("raw-text", "");
      setValue("result-text", "");
      return;
    }
    // For manually update translation task
    this._taskID = lastTask.id;

    if (
      lastTask.type === "text" ||
      (lastTask.raw === "" && lastTask.result === "")
    ) {
      setValue("raw-text", reverseRawResult ? lastTask.result : lastTask.raw);
      setValue(
        "result-text",
        reverseRawResult ? lastTask.raw : lastTask.result,
      );
    }
  }
}
