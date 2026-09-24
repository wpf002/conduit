import { request } from 'undici';
import {
  AuthError,
  RateLimitError,
  SchemaError,
  TransportError,
  registerSecret,
  type AssetClass,
} from '@conduit/core';
import { toOpenFigiSymbol } from './variants.js';

/** OpenFIGI's own limits: 25 requests/minute unkeyed, 250 keyed. */
export const UNKEYED_RATE_LIMIT = 25;
export const KEYED_RATE_LIMIT = 250;

/** Jobs per request: 10 unkeyed, 100 keyed. */
export const UNKEYED_BATCH_SIZE = 10;
export const KEYED_BATCH_SIZE = 100;

export interface OpenFigiJob {
  /** The symbol as the caller knows it. Converted to OpenFIGI's convention before sending. */
  readonly symbol: string;
  /**
   * TICKER by default. ID_BB_GLOBAL looks the instrument up by FIGI, which is the only way to see
   * that a ticker has moved: the FIGI is stable, the ticker is what changed.
   */
  readonly idType?: 'TICKER' | 'ID_BB_GLOBAL';
  readonly exchCode?: string;
  readonly micCode?: string;
  readonly currency?: string;
  readonly assetClass?: AssetClass;
}

export interface OpenFigiMatch {
  readonly figi: string;
  readonly name?: string;
  readonly ticker?: string;
  readonly exchCode?: string;
  readonly securityType?: string;
  readonly marketSector?: string;
  readonly compositeFIGI?: string;
}

export type OpenFigiResult =
  | { readonly kind: 'matched'; readonly job: OpenFigiJob; readonly matches: OpenFigiMatch[] }
  | { readonly kind: 'unmatched'; readonly job: OpenFigiJob; readonly reason: string };

const SECURITY_TYPE: Readonly<Partial<Record<AssetClass, string>>> = {
  equity: 'Common Stock',
  etf: 'ETP',
  future: 'Future',
  option: 'Option',
};

/**
 * A token bucket over a sliding minute. OpenFIGI answers 429 rather than queueing, so the limit is
 * enforced here instead of discovered.
 */
export class RateLimiter {
  #capacity: number;
  #timestamps: number[] = [];
  #now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.#capacity = perMinute;
    this.#now = now;
  }

  /** Milliseconds to wait before the next request is allowed. 0 when it can go now. */
  delayMs(): number {
    const cutoff = this.#now() - 60_000;
    this.#timestamps = this.#timestamps.filter((t) => t > cutoff);
    if (this.#timestamps.length < this.#capacity) return 0;
    return this.#timestamps[0]! + 60_000 - this.#now();
  }

  record(): void {
    this.#timestamps.push(this.#now());
  }

  async acquire(sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
    for (;;) {
      const wait = this.delayMs();
      if (wait <= 0) break;
      await sleep(wait);
    }
    this.record();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OpenFigiClientOptions {
  /** Optional. Raises the limit from 25 to 250 requests per minute and the batch from 10 to 100. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class OpenFigiClient {
  readonly batchSize: number;
  readonly rateLimit: number;

  #apiKey: string | undefined;
  #baseUrl: string;
  #limiter: RateLimiter;
  #sleep: (ms: number) => Promise<void>;

  requestCount = 0;

  constructor(options: OpenFigiClientOptions = {}) {
    this.#apiKey = options.apiKey;
    if (options.apiKey) registerSecret(options.apiKey);
    this.#baseUrl = options.baseUrl ?? 'https://api.openfigi.com';
    this.batchSize = options.apiKey ? KEYED_BATCH_SIZE : UNKEYED_BATCH_SIZE;
    this.rateLimit = options.apiKey ? KEYED_RATE_LIMIT : UNKEYED_RATE_LIMIT;
    this.#limiter = new RateLimiter(this.rateLimit, options.now);
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Splits into batches, respects the rate limit, and preserves input order in the output. */
  async map(jobs: readonly OpenFigiJob[]): Promise<OpenFigiResult[]> {
    const out: OpenFigiResult[] = [];
    for (let i = 0; i < jobs.length; i += this.batchSize) {
      const batch = jobs.slice(i, i + this.batchSize);
      out.push(...(await this.#mapBatch(batch)));
    }
    return out;
  }

  async #mapBatch(batch: readonly OpenFigiJob[]): Promise<OpenFigiResult[]> {
    await this.#limiter.acquire(this.#sleep);
    this.requestCount += 1;

    const body = batch.map((job) => ({
      idType: job.idType ?? 'TICKER',
      // A FIGI is sent verbatim; only a ticker gets the convention conversion.
      idValue: job.idType === 'ID_BB_GLOBAL' ? job.symbol : toOpenFigiSymbol(job.symbol),
      ...(job.exchCode ? { exchCode: job.exchCode } : {}),
      ...(job.micCode ? { micCode: job.micCode } : {}),
      ...(job.currency ? { currency: job.currency } : {}),
      ...(job.assetClass && SECURITY_TYPE[job.assetClass]
        ? { securityType2: job.assetClass === 'etf' ? 'ETP' : undefined }
        : {}),
    }));

    let res;
    try {
      res = await request(new URL('/v3/mapping', this.#baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.#apiKey ? { 'X-OPENFIGI-APIKEY': this.#apiKey } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new TransportError(
        `openfigi request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new AuthError('openfigi rejected the API key');
    }
    if (res.statusCode === 429) {
      const retryAfter = Number(res.headers['retry-after']);
      throw new RateLimitError('openfigi rate limited', {
        ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
      });
    }
    if (res.statusCode >= 400) {
      throw new TransportError(`openfigi HTTP ${res.statusCode}`);
    }

    const payload = (await res.body.json()) as unknown;
    if (!Array.isArray(payload) || payload.length !== batch.length) {
      throw new SchemaError(
        `openfigi returned ${Array.isArray(payload) ? payload.length : 'a non-array'} results for ${batch.length} jobs`,
      );
    }

    return payload.map((entry, i) => {
      const job = batch[i]!;
      if (typeof entry !== 'object' || entry === null) {
        return { kind: 'unmatched' as const, job, reason: 'malformed result' };
      }
      const record = entry as { data?: unknown; error?: unknown; warning?: unknown };
      if (typeof record.error === 'string') {
        return { kind: 'unmatched' as const, job, reason: record.error };
      }
      if (typeof record.warning === 'string' && !Array.isArray(record.data)) {
        return { kind: 'unmatched' as const, job, reason: record.warning };
      }
      if (!Array.isArray(record.data) || record.data.length === 0) {
        return { kind: 'unmatched' as const, job, reason: 'no data' };
      }
      return {
        kind: 'matched' as const,
        job,
        matches: record.data as OpenFigiMatch[],
      };
    });
  }
}
