import { aesEcbEncrypt, base64 } from "../../utils/crypto";
import { getPref, getPrefJSON, setPref } from "../../utils/prefs";
import { publishTranslateTaskProgress } from "../../utils/task";
import { TranslateService } from "./base";
import { CNKI_MAX_TEXT_LENGTH, splitCnkiText } from "./cnkiChunks";
import { CnkiTokenCache } from "./cnkiToken";

const CNKI_REQUEST_TIMEOUT_MS = 15000;

type CnkiResponse = {
  code?: number | string;
  message?: unknown;
  msg?: unknown;
  error?: unknown;
  data?: {
    isInputVerificationCode?: boolean;
    mResult?: unknown;
    message?: unknown;
    msg?: unknown;
  };
};

function responseDetail(response: CnkiResponse | undefined): string {
  const details = [
    response?.code === undefined ? undefined : `code=${response.code}`,
    response?.message,
    response?.msg,
    response?.error,
    response?.data?.message,
    response?.data?.msg,
  ].filter((value) => typeof value === "string" && value.length > 0);
  return details.length ? `（服务返回：${details.join("；")}）` : "";
}

const translate = <TranslateService["translate"]>async function (data) {
  const useSplit = getPref("cnkiUseSplit") !== false;
  const configuredDelay = Number(getPref("cnkiSplitSecond"));
  const splitDelayMs =
    (Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 1) *
    1000;
  if (!data.raw) {
    data.result = "";
    return;
  }
  if (!useSplit && data.raw.length > CNKI_MAX_TEXT_LENGTH) {
    throw new Error(
      `知网单次最多翻译 ${CNKI_MAX_TEXT_LENGTH} 个字符，当前选中了 ${data.raw.length} 个字符。请在知网服务设置中启用分片翻译，或缩短选区后重试。原文未截断。`,
    );
  }

  const processTranslation = async (text: string) => {
    let token = await getToken();
    const words = await getWord(text);
    // Authentication refresh is the only automatic retry. Human verification,
    // network errors and rate limits must be surfaced rather than retried.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!publishTranslateTaskProgress(data)) return undefined;
      let xhr: XMLHttpRequest;
      try {
        xhr = await Zotero.HTTP.request(
          "POST",
          "https://dict.cnki.net/fyzs-front-api/translate/literaltranslation",
          {
            headers: {
              "Content-Type": "application/json;charset=UTF-8",
              Token: token,
            },
            body: JSON.stringify({
              words,
              translateType: null,
            }),
            responseType: "json",
            successCodes: [200, 401],
            timeout: CNKI_REQUEST_TIMEOUT_MS,
            // Zotero otherwise retries 5xx responses for up to an hour.
            errorDelayMax: 0,
          },
        );
      } catch (error) {
        throw new Error(
          `知网翻译请求失败，请稍后重试或切换翻译源。原始错误：${String(error)}`,
        );
      }

      if (!publishTranslateTaskProgress(data)) return undefined;
      const response = xhr.response as CnkiResponse | undefined;
      const detail = responseDetail(response);
      if (response?.data?.isInputVerificationCode) {
        throw new Error(
          `知网要求人工验证。请打开 https://dict.cnki.net/，手动翻译并完成验证，再回到 Zotero 重试。${detail}`,
        );
      }
      if (xhr.status === 401 || Number(response?.code) === 401) {
        if (attempt === 0) {
          token = await getToken(true, token);
          continue;
        }
        throw new Error(
          `知网登录令牌失效，刷新一次后仍无法访问。请稍后重试或切换翻译源。${detail}`,
        );
      }
      if (response?.code !== undefined && Number(response.code) !== 200) {
        throw new Error(`知网服务拒绝了翻译请求。${detail}`);
      }
      const translated = response?.data?.mResult;
      if (typeof translated !== "string" || translated.length === 0) {
        throw new Error(`知网未返回有效译文（缺少 mResult）。${detail}`);
      }
      let regex: RegExp;
      try {
        regex = new RegExp(getPref("cnkiRegex") as string, "g");
      } catch (error) {
        throw new Error(`知网服务的过滤正则无效。原始错误：${String(error)}`);
      }
      return translated.replace(regex, "");
    }
    throw new Error("知网翻译请求未完成，请重试。");
  };

  const chunks = useSplit ? splitCnkiText(data.raw) : [data.raw];
  const translations: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    if (!publishTranslateTaskProgress(data)) return;
    const translated = await processTranslation(chunks[index]);
    if (translated === undefined) return;
    translations.push(translated);
    data.result = translations.join(" ");
    addon.api.getTemporaryRefreshHandler({ task: data })();
    if (index < chunks.length - 1 && splitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, splitDelayMs));
    }
  }
};

const tokenCache = new CnkiTokenCache({
  readCache: () => getPrefJSON("cnkiToken"),
  writeCache: (record) => setPref("cnkiToken", JSON.stringify(record)),
  request: async () => {
    let xhr: XMLHttpRequest;
    try {
      xhr = await Zotero.HTTP.request(
        "GET",
        "https://dict.cnki.net/fyzs-front-api/getToken",
        {
          responseType: "json",
          timeout: CNKI_REQUEST_TIMEOUT_MS,
          errorDelayMax: 0,
        },
      );
    } catch (error) {
      throw new Error(`知网获取令牌失败。原始错误：${String(error)}`);
    }
    const response = xhr.response;
    if (
      Number(response?.code) !== 200 ||
      typeof response?.data !== "string" ||
      !response.data
    ) {
      throw new Error(`知网未返回有效令牌。${responseDetail(response)}`);
    }
    return response.data;
  },
});

let readerPrewarms = new WeakMap<object, Promise<boolean>>();

export function getToken(
  forceRefresh = false,
  rejectedToken?: string,
): Promise<string> {
  return tokenCache.get(forceRefresh, rejectedToken);
}

/** One best-effort anonymous GET per reader; never a translation POST. */
export function prewarmCnkiToken(
  reader: object,
  isReaderOpen: () => boolean = () => true,
): Promise<boolean> {
  if (getPref("translateSource") !== "cnki") return Promise.resolve(false);
  const previous = readerPrewarms.get(reader);
  if (previous) return previous;
  const warmup = Promise.resolve()
    .then(async () => {
      if (!isReaderOpen()) return false;
      await getToken();
      return isReaderOpen();
    })
    .catch(() => false);
  // Failed warmups stay recorded too. Only an explicit translation/retry may
  // request again; rerendering a toolbar must not retry a failed prefetch.
  readerPrewarms.set(reader, warmup);
  return warmup;
}

/** Called by root lifecycle cleanup; no cache clearing or background timers. */
export function cancelCnkiTokenWork(): void {
  tokenCache.cancelPending();
  readerPrewarms = new WeakMap();
}

export async function getWord(text: string) {
  const encrypted = await aesEcbEncrypt(text, "4e87183cfd3a45fe");
  const base64str = base64(encrypted.buffer);
  return base64str.replace(/\//g, "_").replace(/\+/g, "-");
}

export const Cnki: TranslateService = {
  id: "cnki",
  type: "sentence",

  translate,

  config(settings) {
    settings
      .addTextSetting({
        prefKey: "cnkiRegex",
        nameKey: "service-cnki-dialog-regex",
      })
      .addCheckboxSetting({
        prefKey: "cnkiUseSplit",
        nameKey: "service-cnki-dialog-split",
      });
  },
};
