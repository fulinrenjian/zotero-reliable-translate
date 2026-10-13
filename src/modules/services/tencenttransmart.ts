import type { TranslateService } from "./base";

const REQUEST_TIMEOUT_MS = 8000;

export const TencentTransmart: TranslateService = {
  id: "tencenttransmart",
  name: "Tencent Transmart",
  type: "sentence" as const,
  translate: async function (data) {
    const { raw: text } = data;
    // Tencent Transmart only accepts base language code (e.g., 'en', 'zh')
    const from = (data.langfrom || "").split("-")[0];
    const to = (data.langto || "").split("-")[0];
    const URL = "https://transmart.qq.com/api/imt";
    const body = {
      header: {
        fn: "auto_translation",
        client_key:
          "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487",
      },
      type: "plain",
      model_category: "normal",
      source: {
        lang: from,
        text_list: [text],
      },
      target: {
        lang: to,
      },
    };
    const headers = {
      "Content-Type": "application/json",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
      referer: "https://transmart.qq.com/zh-CN/index",
    };

    let xhr: XMLHttpRequest;
    try {
      xhr = await Zotero.HTTP.request("POST", URL, {
        headers,
        body: JSON.stringify(body),
        responseType: "json",
        timeout: REQUEST_TIMEOUT_MS,
        errorDelayMax: 0,
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutException" || name === "TimeoutError") {
        throw new Error("腾讯翻译君请求超时（8 秒）。请重试或切换翻译源。");
      }
      throw new Error("腾讯翻译君请求失败。请检查网络、重试或切换翻译源。");
    }
    if (xhr?.status !== 200) {
      throw new Error("腾讯翻译君服务暂不可用。请重试或切换翻译源。");
    }
    const translated = xhr.response?.auto_translation;
    if (
      !Array.isArray(translated) ||
      translated.some((part: unknown) => typeof part !== "string") ||
      !translated.join("\n").trim()
    ) {
      throw new Error("腾讯翻译君未返回有效译文。请重试或切换翻译源。");
    }
    data.result = translated.join("\n").trim();
  },
};
