export type PopupTextMode = "raw" | "result";

export interface PopupTaskLike {
  raw: string;
  result: string;
  status: "waiting" | "processing" | "success" | "fail";
}

/** Present the translation lifecycle without treating source text as a result. */
export function getPopupPresentation(
  task: PopupTaskLike,
  mode: PopupTextMode = "result",
  sanitize: (text: string) => string = (text) => text,
) {
  const success = task.status === "success" && Boolean(task.result.trim());
  const failed =
    task.status === "fail" || (task.status === "success" && !success);
  const status = failed ? "fail" : task.status;
  const statusLabel = {
    waiting: "等待翻译",
    processing: "正在翻译…",
    success: "翻译完成",
    fail: "翻译失败",
  }[status];

  let resultText: string;
  if (status === "waiting") {
    resultText = "点击“翻译”开始。";
  } else if (status === "processing") {
    resultText = task.result ? sanitize(task.result) : "正在翻译，请稍候…";
  } else if (success) {
    resultText = task.result;
  } else {
    resultText = `${task.status === "fail" && task.result ? sanitize(task.result) : "翻译服务未返回有效译文。"}\n\n点击“重试”，或在下方切换翻译源。`;
  }
  return {
    status,
    statusLabel,
    text: mode === "raw" ? task.raw : resultText,
    translateLabel: failed ? "重试" : success ? "重新翻译" : "翻译",
    translateDisabled: status === "processing",
    copyDisabled: !success,
    copyText: success ? task.result : "",
  };
}
