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
import { normalizeDatabentoRecord } from './normalize.js';

const PROVIDER = 'databento' as const;

const CAPABILITIES: ReadonlySet<Schema> = new Set<Schema>([
  'quote_l1',
  'trades',
  'bars_1m',
  'bars_1d',
  'depth_10',
]);

/** Databento's schema name for each Conduit schema. */
const DBN_SCHEMA: Readonly<Record<string, string>> = {
  quote_l1: 'mbp-1',
  trades: 'trades',
  bars_1m: 'ohlcv-1m',
  bars_1d: 'ohlcv-1d',
  depth_10: 'mbp-10',
};

/** The dataset a symbol lives in is a user decision, not something Conduit can infer. */
export interface DatabentoOptions {
  readonly apiKey: string;
  /** For example 'XNAS.ITCH' for Nasdaq equities or 'GLBX.MDP3' for CME futures. */
  readonly dataset: string;
  readonly baseUrl?: string;
  readonly assetClasses?: readonly AssetClass[];
  readonly staleAfterMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly highWaterMark?: number;
  readonly resolveFigi?: (symbol: string) => string;
  readonly includeRaw?: boolean;
  /** Quota accounting. Hand it `ledger.hooksFor('databento')`. */
  readonly usage?: UsageHooks;
  /** Databento's symbology type for the symbols being passed. */
  readonly stypeIn?: 'raw_symbol' | 'continuous' | 'parent' | 'instrument_id';
}

/**
 * Databento's historical HTTP API, which serves quotes, trades, bars, and ten-level depth as
 * newline-delimited JSON over one request per subscription.
 *
 * Live streaming is deliberately absent. Databento's live feed is length-delimited binary DBN over
 * a raw TCP gateway with a CRAM handshake, which is a different transport from everything else in
 * this package and is not implementable from the published docs with any confidence. stream()
 * therefore requires a replay window and throws CoverageError without one, rather than pretending
 * to offer a live subscription. See docs/databento-live.md.
 */
class DatabentoAdapter implements ProviderAdapter {
  readonly id = PROVIDER;
  readonly capabilities = CAPABILITIES;

  #options: DatabentoOptions;
  #health: HealthTracker;
  #assetClasses: ReadonlySet<AssetClass>;
  #inFlight = new Set<AbortController>();
  #closed = false;

  constructor(options: DatabentoOptions) {
    if (!options.apiKey) {
      throw new AuthError('databento: apiKey is required', { provider: PROVIDER });
    }
    if (!options.dataset) {
      throw new CoverageError('databento: dataset is required, e.g. XNAS.ITCH', {
        provider: PROVIDER,
      });
    }
    registerSecret(options.apiKey);
    this.#options = options;
    this.#assetClasses = new Set(options.assetClasses ?? ['equity', 'etf', 'future', 'option']);
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

  /**
   * The historical API has no point-in-time endpoint — every query is a time range — so there is
   * nothing honest to return here.
   */
  snapshot(req: SnapshotRequest): Promise<QuoteTick[]> {
    return Promise.reject(
      new CoverageError(
        'databento historical has no snapshot endpoint; use stream() with a replay window',
        { provider: PROVIDER, schema: 'quote_l1', ...(req.assetClass ? { assetClass: req.assetClass } : {}) },
      ),
    );
  }

  stream(req: StreamRequest): AsyncIterable<CdmMessage> {
    const assetClass = req.assetClass ?? 'equity';
    if (!this.#assetClasses.has(assetClass)) {
      throw new CoverageError(`databento adapter is configured without ${assetClass}`, {
        provider: PROVIDER,
        schema: req.schema,
        assetClass,
      });
    }
    if (!CAPABILITIES.has(req.schema)) {
      throw new CoverageError(`databento has no ${req.schema} schema`, {
        provider: PROVIDER,
        schema: req.schema,
        assetClass,
      });
    }
    if (req.start === undefined) {
      throw new CoverageError(
        'databento adapter replays a historical window; pass start (and optionally end). Live DBN streaming is not implemented.',
        { provider: PROVIDER, schema: req.schema, assetClass },
      );
    }
    if (this.#closed) {
      throw new TransportError('databento adapter is closed', { provider: PROVIDER });
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
      ...(this.#options.includeRaw === undefined ? {} : { includeRaw: this.#options.includeRaw }),
    };
  }

  async #replay(
    req: StreamRequest,
    queue: AsyncQueue<CdmMessage>,
    controller: AbortController,
  ): Promise<void> {
    const base = this.#options.baseUrl ?? 'https://hist.databento.com';
    const url = new URL('/v0/timeseries.get_range', base);
    const body = new URLSearchParams({
      dataset: this.#options.dataset,
      symbols: req.symbols.join(','),
      schema: DBN_SCHEMA[req.schema]!,
      encoding: 'json',
      stype_in: this.#options.stypeIn ?? 'raw_symbol',
      // Without this, records carry only instrument_id and the symbol cannot be recovered.
      map_symbols: 'true',
      start: nsToIso(req.start!),
      ...(req.end === undefined ? {} : { end: nsToIso(req.end) }),
    });

    try {
      await this.#options.usage?.acquire?.('rest', 1);
      // One event per request, not per record: Databento's limits are on requests, and counting
      // every record as billable would put a fabricated number in a spend report.
      this.#options.usage?.sink?.({
        provider: PROVIDER,
        kind: 'rest',
        count: 1,
        schema: req.schema,
        atNs: nowNs(),
      });
      const res = await request(url, {
        method: 'POST',
        // HTTP basic with the key as the username and an empty password, per Databento's docs.
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.#options.apiKey}:`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new AuthError('databento rejected the API key', { provider: PROVIDER });
      }
      if (res.statusCode === 429) {
        const retryAfter = Number(res.headers['retry-after']);
        throw new RateLimitError('databento rate limited', {
          provider: PROVIDER,
          ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
        });
      }
      if (res.statusCode === 422) {
        throw new CoverageError(
          `databento rejected the query: ${redact((await res.body.text()).slice(0, 300))}`,
          { provider: PROVIDER, schema: req.schema },
        );
      }
      if (res.statusCode >= 400) {
        throw new TransportError(`databento HTTP ${res.statusCode}`, { provider: PROVIDER });
      }

      this.#health.recordConnected();
      let pending = '';
      for await (const chunk of res.body) {
        pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          this.#emitLine(line, req.schema, queue);
          newline = pending.indexOf('\n');
        }
      }
      if (pending.trim().length > 0) this.#emitLine(pending, req.schema, queue);
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
              `databento replay failed: ${redact(error instanceof Error ? error.message : String(error))}`,
              { provider: PROVIDER, cause: error },
            );
      this.#health.recordFailure(wrapped);
      queue.fail(wrapped);
    } finally {
      this.#health.recordDisconnected();
    }
  }

  #emitLine(line: string, schema: Schema, queue: AsyncQueue<CdmMessage>): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      const record = parseJsonLossless(trimmed);
      const message = normalizeDatabentoRecord(record, schema, this.#normalizeOptions());
      if (message) {
        this.#health.recordMessage();
        queue.push(message);
      }
    } catch (error) {
      // One malformed record degrades health; it does not end the replay.
      this.#health.recordFailure(
        error instanceof SchemaError
          ? error
          : new SchemaError(`databento sent an unparseable record`, { provider: PROVIDER }),
      );
    }
  }
}

export function databento(options: DatabentoOptions): ProviderAdapter {
  return new DatabentoAdapter(options);
}

export * from './normalize.js';
