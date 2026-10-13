import { TranslateService } from "./base";

const REQUEST_TIMEOUT_MS = 8000;

const translate: TranslateService["translate"] = async (data) => {
  let xhr: XMLHttpRequest;
  try {
    xhr = await Zotero.HTTP.request(
      "POST",
      `https://edge.microsoft.com/translate/translatetext?from=${data.langfrom}&to=${data.langto}&isEnterpriseClient=false`,
      {
        headers: {
          "content-type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42",
        },
        body: JSON.stringify([data.raw]),
        responseType: "json",
        timeout: REQUEST_TIMEOUT_MS,
        errorDelayMax: 0,
      },
    );
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutException" || name === "TimeoutError") {
      throw new Error("必应翻译请求超时（8 秒）。请重试或切换翻译源。");
    }
    throw new Error("必应翻译请求失败。请检查网络、重试或切换翻译源。");
  }
  if (xhr?.status !== 200) {
    throw new Error("必应翻译服务暂不可用。请重试或切换翻译源。");
  }

  const response = xhr.response;
  const translations = Array.isArray(response)
    ? response[0]?.translations
    : undefined;
  const translated = Array.isArray(translations)
    ? translations[0]?.text
    : undefined;
  if (typeof translated !== "string" || !translated.trim()) {
    throw new Error("必应未返回有效译文。请重试或切换翻译源。");
  }
  data.result = translated;
};

export const Bing: TranslateService = {
  id: "bing",
  type: "sentence",

  translate,
};
