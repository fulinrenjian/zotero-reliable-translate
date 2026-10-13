/** Anonymous CNKI token caching; this module has no HTTP, prefs or logger access. */
export const CNKI_TOKEN_TTL_MS = 300_000;

export interface CnkiTokenRecord {
  token: string;
  t: number;
}

interface TokenOptions {
  request: () => Promise<string>;
  readCache: () => unknown;
  writeCache: (record: CnkiTokenRecord) => void;
  now?: () => number;
}

interface TokenFlight {
  promise: Promise<string>;
  cancel: () => void;
}

export class CnkiTokenCancelledError extends Error {
  constructor() {
    super("知网令牌请求已停止。");
    this.name = "CnkiTokenCancelledError";
  }
}

export class CnkiTokenCache {
  private flight?: TokenFlight;
  private sessionCache?: CnkiTokenRecord;
  private readonly now: () => number;

  constructor(private readonly options: TokenOptions) {
    this.now = options.now || Date.now;
  }

  get(forceRefresh = false, rejectedToken?: string): Promise<string> {
    // A forced refresh must also serve normal callers instead of handing them
    // a token that was just rejected. Concurrent force calls share the GET.
    if (this.flight) return this.flight.promise;
    const cached = this.readValidCache();
    if (
      cached &&
      (!forceRefresh ||
        (rejectedToken !== undefined && cached.token !== rejectedToken))
    ) {
      return Promise.resolve(cached.token);
    }

    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new CnkiTokenCancelledError());
    });
    const flight: TokenFlight = { promise: undefined!, cancel };
    const request = Promise.resolve().then(() => {
      if (this.flight !== flight) throw new CnkiTokenCancelledError();
      return this.options.request();
    });
    flight.promise = Promise.race([request, cancelled])
      .then((token) => {
        if (this.flight !== flight) throw new CnkiTokenCancelledError();
        if (typeof token !== "string" || !token.trim()) {
          throw new Error("知网未返回有效令牌。");
        }
        const record = { token, t: this.now() };
        this.sessionCache = record;
        try {
          this.options.writeCache(record);
        } catch {
          // Keep the same bounded in-memory TTL if preference persistence is
          // temporarily unavailable. Never log the record or the error object.
        }
        return token;
      })
      .finally(() => {
        if (this.flight === flight) this.flight = undefined;
      });
    this.flight = flight;
    return flight.promise;
  }

  /** Detach a pending GET; late resolution/rejection cannot update prefs. */
  cancelPending(): void {
    const current = this.flight;
    this.flight = undefined;
    current?.cancel();
  }

  private readValidCache(): CnkiTokenRecord | undefined {
    const valid = (value: unknown): CnkiTokenRecord | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const record = value as Partial<CnkiTokenRecord>;
      const age = this.now() - (record.t ?? Number.NaN);
      if (
        typeof record.token !== "string" ||
        !record.token.trim() ||
        typeof record.t !== "number" ||
        !Number.isFinite(record.t) ||
        age < 0 ||
        age >= CNKI_TOKEN_TTL_MS
      )
        return undefined;
      return { token: record.token, t: record.t };
    };
    let stored: CnkiTokenRecord | undefined;
    try {
      stored = valid(this.options.readCache());
    } catch {
      /* No credential logging. */
    }
    const session = valid(this.sessionCache);
    return stored && (!session || stored.t >= session.t) ? stored : session;
  }
}
