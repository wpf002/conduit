import { request } from 'undici';
import {
  AuthError,
  CoverageError,
  HealthTracker,
  RateLimitError,
  SchemaError,
  TransportError,
  nowNs,
  nsToIso,
  redact,
  registerSecret,
  type AssetClass,
  type CdmMessage,
  type HealthSnapshot,
  type ProviderAdapter,
  type QuoteTick,
  type Schema,
  type SnapshotRequest,
  type StreamRequest,
  type UsageHooks,
} from '@conduit/core';
import { AsyncQueue } from '../queue.js';
import { parseJsonLossless } from '../json.js';
import { normalizeTiingoBar, type TiingoPriceField } from './normalize.js';

const PROVIDER = 'tiingo' as const;

/** End-of-day bars only. Tiingo's intraday data is a different endpoint and entitlement. */
const CAPABILITIES: ReadonlySet<Schema> = new Set<Schema>(['bars_1d']);

export interface TiingoOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly assetClasses?: readonly AssetClass[];
  readonly staleAfterMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly highWaterMark?: number;
  readonly resolveFigi?: (symbol: string) => string;
  /** 'raw' by default — see the note in normalize.ts, this changes what the numbers mean. */
  readonly priceField?: TiingoPriceField;
  readonly includeRaw?: boolean;
  readonly usage?: UsageHooks;
}

/**
 * Tiingo's end-of-day bars, over its REST API. Replay-only and daily-only, which is the whole of what
 * the free tier offers: there is no streaming feed, no quotes and no trades, so everything else
 * throws CoverageError rather than returning nothing.
 *
 * One HTTP request per symbol — the endpoint is per-ticker — so the governor sees one `rest` unit per
 * symbol, not per call.
 */
class TiingoAdapter implements ProviderAdapter {
  readonly id = PROVIDER;
  readonly capabilities = CAPABILITIES;

  #options: TiingoOptions;
  #health: HealthTracker;
  #assetClasses: ReadonlySet<AssetClass>;
  #inFlight = new Set<AbortController>();
  #closed = false;

  constructor(options: TiingoOptions) {
    if (!options.apiKey) {
      throw new AuthError('tiingo: apiKey is required', { provider: PROVIDER });
    }
    registerSecret(options.apiKey);
    this.#options = options;
    this.#assetClasses = new Set(options.assetClasses ?? ['equity', 'etf']);
    this.#health = new HealthTracker({
      provider: PROVIDER,
      staleAfterMs: options.staleAfterMs ?? 30_000,
      maxConsecutiveFailures: options.maxConsecutiveFailures ?? 3,
    });
  }

  health(): HealthSnapshot {
    return this.#health.snapshot();
  }

  supports(schema: Schema, assetClass: AssetClass): boolean {
    return CAPABILITIES.has(schema) && this.#assetClasses.has(assetClass);
  }

  /** Tiingo's end-of-day API has no quote of any kind. */
  snapshot(req: SnapshotRequest): Promise<QuoteTick[]> {
    return Promise.reject(
      new CoverageError('tiingo serves end-of-day bars only; it has no quotes', {
        provider: PROVIDER,
        schema: 'quote_l1',
        ...(req.assetClass ? { assetClass: req.assetClass } : {}),
      }),
    );
  }

  stream(req: StreamRequest): AsyncIterable<CdmMessage> {
    const assetClass = req.assetClass ?? 'equity';
    if (!this.#assetClasses.has(assetClass)) {
      throw new CoverageError(`tiingo adapter is configured without ${assetClass}`, {
        provider: PROVIDER,
        schema: req.schema,
        assetClass,
      });
    }
    if (!CAPABILITIES.has(req.schema)) {
      throw new CoverageError(`tiingo serves bars_1d only, not ${req.schema}`, {
        provider: PROVIDER,
        schema: req.schema,
        assetClass,
      });
    }
    if (req.start === undefined) {
      throw new CoverageError(
        'tiingo has no streaming feed; pass start (and optionally end) to replay end-of-day bars',
        { provider: PROVIDER, schema: req.schema, assetClass },
      );
    }
    if (this.#closed) {
      throw new TransportError('tiingo adapter is closed', { provider: PROVIDER });
    }
    if (req.symbols.length === 0) {
      return { async *[Symbol.asyncIterator]() {} };
    }

    const queue = new AsyncQueue<CdmMessage>({
      highWaterMark: this.#options.highWaterMark ?? 100_000,
    });
    const controller = new AbortController();
    this.#inFlight.add(controller);
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    void this.#replay(req, queue, controller).finally(() => this.#inFlight.delete(controller));

    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const message of queue) yield message;
        } finally {
          controller.abort();
        }
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#inFlight) controller.abort();
    this.#inFlight.clear();
  }

  #normalizeOptions() {
    return {
      ...(this.#options.resolveFigi ? { resolveFigi: this.#options.resolveFigi } : {}),
      ...(this.#options.priceField ? { priceField: this.#options.priceField } : {}),
      ...(this.#options.includeRaw === undefined ? {} : { includeRaw: this.#options.includeRaw }),
    };
  }

  async #replay(
    req: StreamRequest,
    queue: AsyncQueue<CdmMessage>,
    controller: AbortController,
  ): Promise<void> {
    const base = this.#options.baseUrl ?? 'https://api.tiingo.com';
    try {
      for (const symbol of req.symbols) {
        if (controller.signal.aborted) break;
        await this.#options.usage?.acquire?.('rest', 1);

        const url = new URL(`/tiingo/daily/${encodeURIComponent(symbol)}/prices`, base);
        url.searchParams.set('startDate', nsToIso(req.start!).slice(0, 10));
        if (req.end !== undefined) url.searchParams.set('endDate', nsToIso(req.end).slice(0, 10));
        url.searchParams.set('resampleFreq', 'daily');
        url.searchParams.set('format', 'json');

        // The key goes in a header. Tiingo also accepts ?token=, which would put it in every log.
        const res = await request(url, {
          method: 'GET',
          headers: {
            Authorization: `Token ${this.#options.apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });

        this.#options.usage?.sink?.({
          provider: PROVIDER,
          kind: 'rest',
          count: 1,
          schema: req.schema,
          symbol,
          atNs: nowNs(),
        });

        if (res.statusCode === 401 || res.statusCode === 403) {
          throw new AuthError('tiingo rejected the API key', { provider: PROVIDER });
        }
        if (res.statusCode === 429) {
          const retryAfter = Number(res.headers['retry-after']);
          throw new RateLimitError('tiingo rate limited', {
            provider: PROVIDER,
            ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
          });
        }
        if (res.statusCode === 404) {
          // An unknown ticker is a coverage gap for that symbol, not a broken key.
          this.#health.recordFailure(
            new CoverageError(`tiingo has no data for ${symbol}`, {
              provider: PROVIDER,
              symbol,
              schema: req.schema,
            }),
          );
          continue;
        }
        if (res.statusCode >= 400) {
          throw new TransportError(`tiingo HTTP ${res.statusCode}`, { provider: PROVIDER });
        }

        const body = parseJsonLossless(await res.body.text());
        if (!Array.isArray(body)) {
          this.#health.recordFailure(
            new SchemaError(`tiingo returned a non-array body for ${symbol}`, {
              provider: PROVIDER,
            }),
          );
          continue;
        }

        for (const entry of body) {
          try {
            const bar = normalizeTiingoBar(entry, symbol, this.#normalizeOptions());
            if (bar) {
              this.#health.recordMessage();
              queue.push(bar);
            }
          } catch (error) {
            this.#health.recordFailure(error);
          }
        }
      }
      queue.end();
    } catch (error) {
      if (controller.signal.aborted) {
        queue.end();
        return;
      }
      const wrapped =
        error instanceof AuthError ||
        error instanceof RateLimitError ||
        error instanceof CoverageError ||
        error instanceof TransportError
          ? error
          : new TransportError(
              `tiingo replay failed: ${redact(error instanceof Error ? error.message : String(error))}`,
              { provider: PROVIDER, cause: error },
            );
      this.#health.recordFailure(wrapped);
      queue.fail(wrapped);
    }
  }
}

export function tiingo(options: TiingoOptions): ProviderAdapter {
  return new TiingoAdapter(options);
}

export * from './normalize.js';
