import { TranslateService } from "./base";
import {
  getString,
  getPref,
  getLastTranslateTask,
  sanitizeTaskForLog,
  TranslateTask,
  TranslateTaskRunner,
  autoDetectLanguage,
  updateTranslateTaskLang,
  invalidateTranslateTask,
  matchLanguage,
  stripEmptyLines,
} from "../../utils";

import { Aliyun } from "./aliyun";
import { Tencent } from "./tencent";
import { ChatGPT, customGPT1, customGPT2, customGPT3, azureGPT } from "./gpt";
import { Baidu } from "./baidu";
import { BaiduField } from "./baidufield";
import { Bing } from "./bing";
import { BingDict } from "./bingdict";
import { Caiyun } from "./caiyun";
import { CambridgeDict } from "./cambridgedict";
import { Claude } from "./claude";
import { Cnki } from "./cnki";
import { CollinsDict } from "./collinsdict";
import { DeeplFree, DeeplPro } from "./deepl";
import { FreeDictionaryAPI } from "./freedictionaryapi";
import { Gemini } from "./gemini";
import { Google, GoogleAPI } from "./google";
import { Haici } from "./haici";
import { HaiciDict } from "./haicidict";
import { GramotaDict } from "./gramotadict";
import { Huoshan } from "./huoshan";
import { HuoshanWeb } from "./huoshanweb";
import { Iciba } from "./iciba";
import { LibreTranslate } from "./libretranslate";
import { Microsoft } from "./microsoft";
import { Mtranserver } from "./mtranserver";
import { MyMemory } from "./mymemory";
import { Niutrans } from "./niutrans";
import { Nllb } from "./nllb";
import { Openl } from "./openl";
import { Pot } from "./pot";
import { QwenMT } from "./qwenmt";
import { WeblioDict } from "./webliodict";
import { XFfrans } from "./xftrans";
import { TencentTransmart } from "./tencenttransmart";
import { Youdao } from "./youdao";
import { YoudaoDict } from "./youdaodict";
import { YoudaoZhiyun } from "./youdaozhiyun";
import { YoudaoZhiyunLLM } from "./youdaozhiyunllm";
import { DeepLCustom } from "./deeplcustom";
import { DeepLX } from "./deeplx";

const register: TranslateService[] = [
  Aliyun,
  Baidu,
  BaiduField,
  Bing,
  BingDict,
  Caiyun,
  CambridgeDict,
  Claude,
  Cnki,
  CollinsDict,
  DeeplFree,
  DeeplPro,
  DeepLCustom,
  DeepLX,
  FreeDictionaryAPI,
  Gemini,
  GramotaDict,
  Google,
  GoogleAPI,
  ChatGPT,
  customGPT1,
  customGPT2,
  customGPT3,
  azureGPT,
  Haici,
  HaiciDict,
  Huoshan,
  HuoshanWeb,
  Iciba,
  LibreTranslate,
  Microsoft,
  Mtranserver,
  MyMemory,
  Niutrans,
  Nllb,
  Openl,
  Pot,
  QwenMT,
  Tencent,
  TencentTransmart,
  WeblioDict,
  XFfrans,
  Youdao,
  YoudaoDict,
  YoudaoZhiyun,
  YoudaoZhiyunLLM,
];

export class TranslationServices {
  #inFlight = new WeakMap<TranslateTask, Promise<boolean>>();
  #services: readonly TranslateService[] = Object.freeze(
    this.sortServices(register),
  );

  /**
   * Sort the TranslateService list by the following rules:
   * 1. Free and no-config services (no secret, no config) come first.
   * 2. All other services are sorted by `id` in ascending order (case-insensitive).
   * 3. Services whose `id` starts with "custom" are placed last
   *    (sorted by `id` in ascending order within this group).
   */
  private sortServices<T extends TranslateService>(services: T[]) {
    return services.sort((a, b) => {
      const rank = (s: T) => {
        const needsSecret = !!s.defaultSecret || !!s.secretValidator;
        const hasConfig = !!s.config;
        const needExternalConfig = s.requireExternalConfig;

        // Rank for sentence services
        if (s.type === "sentence") {
          // Group 4: "custom" at the start → last
          if (s.id.startsWith("custom")) return 3;

          // Group 1: Free sentence services (no secret, no external config)
          if (!needsSecret && !needExternalConfig) return 0;

          // Group 2: No-secret but requires external config
          if (!needsSecret && needExternalConfig) return 1;

          // Group 3: Needs secret but no config
          if (needsSecret && !hasConfig) return 2;

          // Default (Sentence service needs secret and has config) — also rank 2
          return 2;
        }
        // Rank for word services
        else {
          // Default //TODO Modify it if necessary in the future
          return 0;
        }
      };

      const ra = rank(a);
      const rb = rank(b);

      if (ra !== rb) return ra - rb;
      return a.id.localeCompare(b.id);
    });
  }

  public getServiceById(id: string): TranslateService | undefined {
    return this.#services.find((service) => service.id === id);
  }

  public getAllServices(): TranslateService[] {
    return [...this.#services];
  }

  public getAllServicesWithType(type: string): TranslateService[] {
    return this.getAllServices().filter((service) => service.type === type);
  }

  public getServiceNameByID(id: string): string {
    const baseName =
      (getPref(`renameServices.${id}`) as string) || getString(`service-${id}`);
    const service = this.getServiceById(id);
    if (
      !!service?.defaultSecret ||
      !!service?.secretValidator ||
      id.startsWith("custom")
    ) {
      return baseName + "🗝️";
    }
    if (service?.requireExternalConfig) {
      return baseName + "📍";
    }
    return baseName;
  }

  public getAllServiceNames(): string[] {
    return this.getAllServices().map((service) =>
      this.getServiceNameByID(service.id),
    );
  }

  public getAllServiceNamesWithType(type: string): string[] {
    return this.getAllServicesWithType(type).map((service) =>
      this.getServiceNameByID(service.id),
    );
  }

  /**
   * Get the set of unconfigured service IDs.
   * A service is unconfigured if it requires a secret but none is set or validation fails.
   * @returns Set of service IDs that are not configured
   */
  public getUnconfiguredServiceIds(): Set<string> {
    const unconfigured = new Set<string>();

    let secrets: Record<string, string> = {};
    try {
      secrets = JSON.parse((getPref("secretObj") as string) || "{}");
    } catch {
      secrets = {};
    }

    for (const service of this.#services) {
      const needsSecret =
        !!service.defaultSecret ||
        !!service.secretValidator ||
        service.id.startsWith("custom");

      if (!needsSecret) continue;

      const secret = secrets[service.id] || "";
      if (!secret) {
        unconfigured.add(service.id);
        continue;
      }

      if (service.secretValidator) {
        try {
          if (!service.secretValidator(secret).status) {
            unconfigured.add(service.id);
          }
        } catch {
          // Validation error - treat as configured
        }
      }
    }

    return unconfigured;
  }

  public async runTranslationTask(
    task?: TranslateTask,
    options: {
      noCheckZoteroItemLanguage?: boolean;
      noDisplay?: boolean;
      noCache?: boolean;
    } = {},
  ): Promise<boolean> {
    task = task || getLastTranslateTask();
    if (!task || !task.raw?.trim() || !addon.data.alive) return false;
    const pending = this.#inFlight.get(task);
    if (pending) return pending;
    const currentTask = task;
    const work = this.runTask(currentTask, options).catch(() => {
      invalidateTranslateTask(currentTask);
      currentTask.status = "fail";
      currentTask.result = "翻译请求未完成，请重试或切换翻译源。";
      if (!options.noDisplay && addon.data.alive)
        addon.api.getTemporaryRefreshHandler()();
      return false;
    });
    this.#inFlight.set(currentTask, work);
    try {
      return await work;
    } finally {
      if (this.#inFlight.get(currentTask) === work)
        this.#inFlight.delete(currentTask);
    }
  }

  private async runTask(
    task: TranslateTask,
    options: {
      noCheckZoteroItemLanguage?: boolean;
      noDisplay?: boolean;
      noCache?: boolean;
    },
  ): Promise<boolean> {
    ztoolkit.log("runTranslationTask", options);
    const { noCache, noCheckZoteroItemLanguage, noDisplay } = options;
    invalidateTranslateTask(task);
    if (task.processed) updateTranslateTaskLang(task);
    if (!task.langfrom || !task.langto) {
      const detected = autoDetectLanguage(Zotero.Items.get(task.itemId || -1));
      task.langfrom = task.langfrom || detected.fromLanguage;
      task.langto = task.langto || detected.toLanguage;
      if (detected.isInferred) task.langfromInferred = true;
    }
    task.status = "processing" as TranslateTask["status"];
    // Check whether item language is in disabled languages list
    let disabledByItemLanguage = false;
    if (!noCheckZoteroItemLanguage && task.itemId) {
      const item = Zotero.Items.getTopLevel([Zotero.Items.get(task.itemId)])[0];
      if (item && task.type !== "custom") {
        const declaredLanguage = String(item.getField("language") || "").trim();
        const itemLanguage = declaredLanguage
          ? matchLanguage(declaredLanguage).code || declaredLanguage
          : task.langfrom || "";
        const disabledLanguages = (getPref("disabledLanguages") as string)
          .split(/[,;，；]/)
          .map((lang) => lang.trim().toLowerCase())
          .filter(Boolean);
        disabledByItemLanguage =
          !!itemLanguage &&
          disabledLanguages.some(
            (language) =>
              language === itemLanguage.toLowerCase() ||
              language === itemLanguage.split("-")[0].toLowerCase(),
          );
      }
    }
    if (disabledByItemLanguage) {
      ztoolkit.log("disabledByItemLanguage");
      task.status = "fail";
      task.result =
        "该文献语言已设置为不自动翻译。点击翻译/重试或按 Ctrl+T 可手动翻译。";
      if (!noDisplay) addon.api.getTemporaryRefreshHandler()();
      return false;
    }
    // Remove possible translation results (for annotations).
    const splitChar = (getPref("splitChar") as string).trim();
    // /🔤[^🔤]*🔤/g
    const regex =
      splitChar === ""
        ? ""
        : new RegExp(`${splitChar}[^${splitChar}]*${splitChar}`, "g");
    task.raw = task.raw.replace(regex, "");
    task.result = "";
    // Display raw
    if (!noDisplay) {
      addon.api.getTemporaryRefreshHandler()();
    }

    let cacheHit = false;
    if (!noCache) {
      // Check cache
      const cachedTask = addon.data.translate.queue.findLast((_t) => {
        return (
          _t.status === "success" &&
          _t.raw === task!.raw &&
          _t.service === task!.service &&
          (!task.langfrom || _t.langfrom === task.langfrom) &&
          (!task.langto || _t.langto === task.langto)
        );
      });

      if (cachedTask) {
        cacheHit = true;
        ztoolkit.log("cache hit", sanitizeTaskForLog(cachedTask));
        task.audio = cachedTask.audio;
        task.result = cachedTask.result;
        task.status = "success";

        if (!noDisplay) {
          addon.api.getTemporaryRefreshHandler()();
        }
      }
    }

    if (!cacheHit) {
      // Get task service
      const service = this.getServiceById(task.service);
      if (!service) {
        task.result = `${task.service} is not implemented.`;
        task.status = "fail";
        if (!noDisplay) addon.api.getTemporaryRefreshHandler()();
        return false;
      }

      // Run task
      const runner = new TranslateTaskRunner(service.translate);
      if (!(await runner.run(task)) || !addon.data.alive) return false;

      // Apply strip empty lines if enabled
      const stripEnabled = getPref("stripEmptyLines") as boolean;
      if (task.status === "success" && stripEnabled && task.result) {
        task.result = stripEmptyLines(task.result, true);
      }

      const resultRegex = getPref("resultRegex") as string;
      if (task.status === "success" && resultRegex) {
        try {
          const regex = new RegExp(resultRegex, "g");
          // Remove all matches
          task.result = task.result.replace(regex, "");
        } catch (e) {
          ztoolkit.log("Invalid result regex", e);
          task.result = `Invalid result regex: ${resultRegex}. Please check settings > Translate > Advanced > Result Regex.`;
          task.status = "fail";
        }
      }
      if (task.status === "success" && !task.result.trim()) {
        task.status = "fail";
        task.result = "服务未返回可用译文，请重试或切换翻译源。";
      }

      // Run extra tasks. Do not wait.
      if (task.extraTasks?.length) {
        Promise.all(
          task.extraTasks.map((extraTask) => {
            return this.runTranslationTask(extraTask, {
              noCheckZoteroItemLanguage,
              noDisplay: true,
            });
          }),
        ).then(() => {
          addon.hooks.onReaderTabPanelRefresh();
        });
      }
      // Try candidate services if current run fails
      if (task.status === "fail" && task.candidateServices.length > 0) {
        task.service = task.candidateServices.shift()!;
        task.status = "waiting";
        return await this.runTask(task, options);
      } else {
        // Display result
        if (!noDisplay) {
          addon.api.getTemporaryRefreshHandler()();
        }
      }
    }

    const success = task.status === "success";
    const item = Zotero.Items.get(task.itemId!);
    // Data storage for corresponding types
    if (success) {
      switch (task.type) {
        case "annotation":
          {
            if (item) {
              const savePosition = getPref("annotationTranslationPosition") as
                | "comment"
                | "body";
              const savePositionInBody = getPref(
                "annotationTranslationPositionInBody",
              ) as "before" | "after";
              const currentText = (
                (savePosition === "comment"
                  ? item.annotationComment
                  : item.annotationText) || ""
              ).replace(regex, "");
              const translationText = `${splitChar}${task.result}${splitChar}\n`;
              let text = `${
                currentText[currentText.length - 1] === "\n" ? "" : "\n"
              }${translationText}`;
              if (splitChar !== "") {
                text =
                  savePosition === "body" && savePositionInBody === "before"
                    ? `${translationText}${currentText}`
                    : `${currentText}${text}`;
              }
              item[
                savePosition === "comment"
                  ? "annotationComment"
                  : "annotationText"
              ] = text;

              // Auto tag
              const enableAutoTag = getPref(
                "enableAutoTagAnnotation",
              ) as boolean;
              if (enableAutoTag) {
                const tagContent = getPref("annotationTagContent") as string;
                if (tagContent && tagContent.trim()) {
                  const tag = tagContent.trim();
                  // Check if the tag already exists
                  const existingTags = item.getTags();
                  const tagExists = existingTags.some(
                    (existingTag) => existingTag.tag === tag,
                  );

                  if (!tagExists) {
                    item.addTag(tag);
                  }
                }
              }
              item.saveTx();
            }
          }
          break;
        case "title":
          {
            if (item) {
              ztoolkit.ExtraField.setExtraField(
                item,
                "titleTranslation",
                task.result,
              );
              item.saveTx();
            }
          }
          break;
        case "abstract":
          {
            if (item) {
              ztoolkit.ExtraField.setExtraField(
                item,
                "abstractTranslation",
                // A dirty workaround to make it collapsible on Zotero 6
                task.result,
              );
              item.saveTx();
            }
          }
          break;
        default:
          break;
      }
    }
    return success;
  }
}

export const services = new TranslationServices();
