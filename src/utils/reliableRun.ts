/**
 * Request lifecycle independent of Zotero and any translation provider.
 * A provider owns an isolated attempt; only its current attempt can publish.
 * Racing a deadline cannot abort every provider, so expired attempts stay
 * detached even if an HTTP callback runs after the deadline.
 */
export interface ReliableTaskLike {
  result: string;
  status: "waiting" | "processing" | "success" | "fail";
  processed?: boolean;
  secret?: string;
}

export class ReliableRunError extends Error {
  constructor(
    public readonly code: "timeout" | "empty" | "service",
    message: string,
  ) {
    super(message);
    this.name = "ReliableRunError";
  }
}

interface AttemptState {
  isCurrent: () => boolean;
  publish: () => boolean;
  supersede: () => void;
}

// These maps are shared across runner instances; the service layer creates a
// new runner for every invocation, including fallback/retry invocations.
const currentAttempts = new WeakMap<object, AttemptState>();
const attemptStates = new WeakMap<object, AttemptState>();
const activeAttempts = new Set<AttemptState>();

export interface ReliableRunOptions<T extends ReliableTaskLike> {
  timeoutMs: number;
  clone: (task: T) => T;
  commit: (task: T, attempt: T, progress: boolean) => void;
  formatError: (error: unknown, attempt: T) => string;
  isTaskUnchanged?: () => boolean;
  isResultValid?: (result: string) => boolean;
}

/** Returns false for expired/superseded attempt callbacks. */
export function publishReliableTaskProgress(task: object): boolean {
  const state = attemptStates.get(task);
  // Existing API users also pass ordinary (non-attempt) tasks.
  return state ? state.publish() : true;
}

/** Invalidates an in-flight provider without requiring transport cancellation. */
export function invalidateReliableTask(task: object): void {
  currentAttempts.get(task)?.supersede();
  currentAttempts.delete(task);
}

/** On plugin shutdown, no pending callback may publish to a removed UI. */
export function invalidateAllReliableTasks(): void {
  for (const state of activeAttempts) state.supersede();
  activeAttempts.clear();
}

/**
 * Returns true if this invocation committed its result (success or failure).
 * False means a later invocation owns the task, so callers must also stop
 * fallback, formatting and item-storage work for this obsolete invocation.
 */
export async function runReliableTask<T extends ReliableTaskLike>(
  task: T,
  processor: (attempt: T) => Promise<void> | void,
  options: ReliableRunOptions<T>,
): Promise<boolean> {
  const attempt = options.clone(task);
  attempt.result = "";
  attempt.status = "processing";
  task.result = "";
  task.status = "processing";

  let finished = false;
  let wasSuperseded = false;
  let resolveSuperseded!: (value: "superseded") => void;
  const superseded = new Promise<"superseded">((resolve) => {
    resolveSuperseded = resolve;
  });
  const state: AttemptState = {
    isCurrent: () =>
      !finished &&
      !wasSuperseded &&
      currentAttempts.get(task) === state &&
      (options.isTaskUnchanged?.() ?? true),
    publish: () => {
      if (!state.isCurrent()) return false;
      // Provider callbacks may mark their private attempt as success; the
      // public task remains processing until the provider promise settles.
      options.commit(task, attempt, true);
      task.status = "processing";
      return true;
    },
    supersede: () => {
      wasSuperseded = true;
      resolveSuperseded("superseded");
    },
  };
  currentAttempts.get(task)?.supersede();
  currentAttempts.set(task, state);
  attemptStates.set(attempt, state);
  activeAttempts.add(state);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () =>
        reject(
          new ReliableRunError(
            "timeout",
            `翻译请求超时（${Math.ceil(options.timeoutMs / 1000)} 秒）。请重试或切换翻译源。`,
          ),
        ),
      options.timeoutMs,
    );
  });

  try {
    const outcome = await Promise.race([
      // Promise.resolve also catches synchronous provider exceptions. The
      // rejection handler installed by race consumes late rejections.
      Promise.resolve().then(() => {
        if (!state.isCurrent()) return;
        return processor(attempt);
      }),
      deadline,
      superseded,
    ]);
    if (outcome === "superseded" || !state.isCurrent()) return false;
    // The provider mutates its attempt asynchronously; widen the status read
    // rather than keeping TypeScript's initial "processing" narrowing.
    if ((attempt as ReliableTaskLike).status === "fail") {
      throw new ReliableRunError(
        "service",
        attempt.result || "翻译服务返回失败。请重试或切换翻译源。",
      );
    }
    if (
      !attempt.result?.trim() ||
      (options.isResultValid && !options.isResultValid(attempt.result))
    ) {
      throw new ReliableRunError(
        "empty",
        "翻译服务未返回有效译文。请重试或切换翻译源。",
      );
    }
    attempt.status = "success";
  } catch (error) {
    if (!state.isCurrent()) return false;
    attempt.status = "fail";
    try {
      attempt.result = options.formatError(error, attempt);
    } catch {
      // Error presentation must not leave the public task processing forever
      // or expose a secondary formatter exception containing credentials.
      attempt.result = "翻译失败，错误信息无法解析。请重试或切换翻译源。";
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    // This prevents an already-resolved onload/progress handler from writing
    // again after the task has committed or an invocation has been replaced.
    finished = true;
    activeAttempts.delete(state);
  }

  options.commit(task, attempt, false);
  task.status = attempt.status;
  task.processed = true;
  return true;
}

/** Remove credentials from service errors, including URL/header forms. */
export function redactServiceError(detail: string, secret?: string): string {
  let redacted = detail;
  let jsonParts: string[] = [];
  if (secret) {
    try {
      const collect = (value: unknown): string[] => {
        if (typeof value === "string") return value ? [value] : [];
        if (Array.isArray(value)) return value.flatMap(collect);
        if (value && typeof value === "object") {
          return Object.values(value).flatMap(collect);
        }
        return [];
      };
      jsonParts = collect(JSON.parse(secret));
    } catch {
      // Most services use a scalar or #-separated credential instead of JSON.
    }
  }
  const secretParts = [
    secret || "",
    ...(secret || "").split("#"),
    ...jsonParts,
  ].filter(Boolean);
  const candidates = new Set(
    secretParts.flatMap((part) => {
      try {
        return [part, encodeURIComponent(part)];
      } catch {
        return [part];
      }
    }),
  );
  for (const value of [...candidates].sort((a, b) => b.length - a.length)) {
    // Percent escapes are case-insensitive even though credential text is not.
    const pattern = value
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(
        /%[0-9a-f]{2}/gi,
        (escape) => `(?:${escape.toUpperCase()}|${escape.toLowerCase()})`,
      );
    redacted = redacted.replace(new RegExp(pattern, "g"), "[REDACTED]");
  }
  redacted = redacted
    .replace(/\b(Bearer|Basic)\s+[^\s"',;}]+/gi, "$1 [REDACTED]")
    .replace(/(\bhttps?:\/\/)[^/\s]+@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:api[-_]?key|key|secret(?:key)?|token|(?:access|refresh|id)[-_]?token|client[-_]?secret|password|passwd|authorization|access[-_]?key(?:[-_]?(?:id|secret))?)=)[^&\s#]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[-_]?key|key|secret(?:key)?|token|(?:access|refresh|id)[-_]?token|client[-_]?secret|password|passwd|x-api-key|authorization|access[-_]?key(?:[-_]?(?:id|secret))?)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^"'\s,};&]+)/gi,
      "$1[REDACTED]",
    );
  return redacted;
}

/** CNKI executes its chunks serially, with a configured delay after each. */
export function getTranslationTimeoutMs(options: {
  serviceType?: "word" | "sentence";
  service: string;
  raw: string;
  cnkiUseSplit?: boolean;
  cnkiSplitSecond?: number;
}): number {
  if (options.serviceType === "word") return 20_000;
  const sentenceTimeout = 45_000;
  if (options.service !== "cnki" || !options.cnkiUseSplit) {
    return sentenceTimeout;
  }
  const chunks = Math.max(1, Math.ceil(options.raw.length / 800));
  const delay = Number.isFinite(options.cnkiSplitSecond)
    ? Math.max(0, options.cnkiSplitSecond || 0) * 1000
    : 0;
  return Math.min(180_000, sentenceTimeout + (chunks - 1) * (25_000 + delay));
}
