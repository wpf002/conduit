import { request } from 'undici';
import {
  AuthError,
  CoverageError,
  HealthTracker,
  RateLimitError,
  TransportError,
  UNRESOLVED_FIGI,
  nowNs,
  redact,
  registerSecret,
  type AssetClass,
  type BackoffOptions,
  type CdmMessage,
  type HealthSnapshot,
  type MarketMessage,
  type ProviderAdapter,
  type QuoteTick,
  type Schema,
  type SnapshotRequest,
  type StreamRequest,
} from '@conduit/core';
import { AsyncQueue } from '../queue.js';
import { parseJsonLossless } from '../json.js';
import { ReconnectingSocket } from '../ws.js';
import { SubscriptionRegistry } from '../subscriptions.js';
import { normalizePolygonMessage, normalizePolygonSnapshot } from './normalize.js';

const PROVIDER = 'polygon' as const;

/** Streamable schemas. bars_1d and depth_10 are REST-only or unentitled, so they throw. */
const CAPABILITIES: ReadonlySet<Schema> = new Set<Schema>(['quote_l1', 'trades', 'bars_1m']);

const SUPPORTED_ASSET_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>(['equity', 'etf']);

const CHANNEL: Readonly<Record<string, string>> = {
  quote_l1: 'Q',
  trades: 'T',
  bars_1m: 'AM',
};

export interface PolygonOptions {
  readonly apiKey: string;
  /** Defaults to the delayed/realtime stocks cluster. */
  readonly wsUrl?: string;
  readonly restBaseUrl?: string;
  readonly staleAfterMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly backoff?: BackoffOptions;
  /** Client keepalive. 0 disables it; a missing pong forces a reconnect. */
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly highWaterMark?: number;
  readonly resolveFigi?: (symbol: string) => string;
  readonly quoteSizeUnits?: 'lots' | 'shares';
  readonly includeRaw?: boolean;
  /** Test seam. Production code never passes this. */
  readonly socketFactory?: ConstructorParameters<typeof ReconnectingSocket>[1];
}

interface Consumer {
  readonly schema: Schema;
  readonly symbols: ReadonlySet<string>;
  readonly queue: AsyncQueue<CdmMessage>;
}

class PolygonAdapter implements ProviderAdapter {
  readonly id = PROVIDER;
  readonly capabilities = CAPABILITIES;

  #options: PolygonOptions;
  #health: HealthTracker;
  #registry = new SubscriptionRegistry();
  #consumers = new Set<Consumer>();
  #socket: ReconnectingSocket | undefined;
  #authenticated = false;
  #closed = false;

  constructor(options: PolygonOptions) {
    if (!options.apiKey) {
      throw new AuthError('polygon: apiKey is required', { provider: PROVIDER });
    }
    registerSecret(options.apiKey);
    this.#options = options;
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
    return CAPABILITIES.has(schema) && SUPPORTED_ASSET_CLASSES.has(assetClass);
  }

  #assertSupported(schema: Schema, assetClass: AssetClass): void {
    if (!SUPPORTED_ASSET_CLASSES.has(assetClass)) {
      throw new CoverageError(`polygon adapter covers US equities and ETFs, not ${assetClass}`, {
        provider: PROVIDER,
        schema,
        assetClass,
      });
    }
    if (!CAPABILITIES.has(schema)) {
      throw new CoverageError(`polygon adapter cannot stream ${schema}`, {
        provider: PROVIDER,
        schema,
        assetClass,
      });
    }
  }

  // ------------------------------------------------------------------- REST
  async snapshot(req: SnapshotRequest): Promise<QuoteTick[]> {
    const assetClass = req.assetClass ?? 'equity';
    this.#assertSupported('quote_l1', assetClass);
    if (req.symbols.length === 0) return [];

    const base = this.#options.restBaseUrl ?? 'https://api.polygon.io';
    const url = new URL('/v2/snapshot/locale/us/markets/stocks/tickers', base);
    url.searchParams.set('tickers', req.symbols.join(','));
    // The key goes in a header, never the query string, so it cannot leak into a log or a proxy.
    let res;
    try {
      res = await request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.#options.apiKey}`, Accept: 'application/json' },
      });
    } catch (error) {
      const err = new TransportError(
        `polygon snapshot request failed: ${redact(error instanceof Error ? error.message : String(error))}`,
        { provider: PROVIDER, cause: error },
      );
      this.#health.recordFailure(err);
      throw err;
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      const err = new AuthError('polygon rejected the API key on snapshot', { provider: PROVIDER });
      this.#health.recordFailure(err);
      throw err;
    }
    if (res.statusCode === 429) {
      const retryAfter = Number(res.headers['retry-after']);
      const err = new RateLimitError('polygon snapshot rate limited', {
        provider: PROVIDER,
        ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
      });
      this.#health.recordFailure(err);
      throw err;
    }
    if (res.statusCode >= 400) {
      const err = new TransportError(`polygon snapshot HTTP ${res.statusCode}`, {
        provider: PROVIDER,
      });
      this.#health.recordFailure(err);
      throw err;
    }

    // Read as text and parse losslessly: lastQuote.t is a 19-digit nanosecond epoch, which
    // res.body.json() would round to the nearest double.
    const body = parseJsonLossless(await res.body.text()) as { tickers?: unknown[] };
    const out: QuoteTick[] = [];
    for (const entry of body.tickers ?? []) {
      const quote = normalizePolygonSnapshot(entry, this.#normalizeOptions());
      if (quote) out.push(quote);
    }
    this.#health.recordMessage(out.length);
    return out;
  }

  // ----------------------------------------------------------------- stream
  stream(req: StreamRequest): AsyncIterable<CdmMessage> {
    const assetClass = req.assetClass ?? 'equity';
    this.#assertSupported(req.schema, assetClass);
    if (this.#closed) {
      throw new TransportError('polygon adapter is closed', { provider: PROVIDER });
    }

    const queue = new AsyncQueue<CdmMessage>({
      highWaterMark: this.#options.highWaterMark ?? 100_000,
    });
    const consumer: Consumer = {
      schema: req.schema,
      symbols: new Set(req.symbols),
      queue,
    };
    this.#consumers.add(consumer);

    const added = this.#registry.add(req.schema, req.symbols);
    this.#ensureSocket();
    if (this.#authenticated && added.length > 0) this.#sendSubscribe(req.schema, added);

    const detach = (): void => {
      this.#consumers.delete(consumer);
      const stillWanted = new Set<string>();
      for (const other of this.#consumers) {
        if (other.schema === req.schema) for (const s of other.symbols) stillWanted.add(s);
      }
      const orphaned = req.symbols.filter((s) => !stillWanted.has(s));
      if (orphaned.length > 0) {
        this.#registry.remove(req.schema, orphaned);
        this.#sendUnsubscribe(req.schema, orphaned);
      }
    };

    if (req.signal) {
      if (req.signal.aborted) queue.end();
      else req.signal.addEventListener('abort', () => queue.end(), { once: true });
    }

    // Wrapping the queue keeps detach tied to the iterator's lifetime, including early break.
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const message of queue) yield message;
        } finally {
          detach();
          if (self.#consumers.size === 0) await self.#teardownSocket();
        }
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#registry.clear();
    for (const consumer of this.#consumers) consumer.queue.end();
    this.#consumers.clear();
    await this.#teardownSocket();
  }

  // ---------------------------------------------------------------- internals
  #normalizeOptions() {
    return {
      ...(this.#options.resolveFigi ? { resolveFigi: this.#options.resolveFigi } : {}),
      ...(this.#options.quoteSizeUnits ? { quoteSizeUnits: this.#options.quoteSizeUnits } : {}),
      ...(this.#options.includeRaw === undefined ? {} : { includeRaw: this.#options.includeRaw }),
    };
  }

  #ensureSocket(): void {
    if (this.#socket) return;
    this.#socket = new ReconnectingSocket(
      {
        url: this.#options.wsUrl ?? 'wss://socket.polygon.io/stocks',
        health: this.#health,
        ...(this.#options.backoff ? { backoff: this.#options.backoff } : {}),
        ...(this.#options.pingIntervalMs === undefined
          ? {}
          : { pingIntervalMs: this.#options.pingIntervalMs }),
        ...(this.#options.pongTimeoutMs === undefined
          ? {}
          : { pongTimeoutMs: this.#options.pongTimeoutMs }),
        onOpen: (ctx) => {
          this.#authenticated = false;
          ctx.send(JSON.stringify({ action: 'auth', params: this.#options.apiKey }));
        },
        onText: (data) => this.#onText(data),
        onFatal: (error) => {
          // A revoked key cannot be retried. Consumers must see it, not a silent stall.
          for (const consumer of this.#consumers) consumer.queue.fail(error);
        },
      },
      this.#options.socketFactory,
    );
    this.#socket.start();
  }

  async #teardownSocket(): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#authenticated = false;
    await socket?.close();
  }

  #channelsFor(schema: Schema, symbols: readonly string[]): string {
    const prefix = CHANNEL[schema];
    return symbols.map((s) => `${prefix}.${s}`).join(',');
  }

  #sendSubscribe(schema: Schema, symbols: readonly string[]): void {
    if (symbols.length === 0) return;
    this.#socket?.send(
      JSON.stringify({ action: 'subscribe', params: this.#channelsFor(schema, symbols) }),
    );
  }

  #sendUnsubscribe(schema: Schema, symbols: readonly string[]): void {
    if (symbols.length === 0 || !this.#socket) return;
    this.#socket.send(
      JSON.stringify({ action: 'unsubscribe', params: this.#channelsFor(schema, symbols) }),
    );
  }

  /** Replays the whole registry. This is what makes a reconnect invisible to the consumer. */
  #resubscribeAll(): void {
    for (const { schema, symbols } of this.#registry.all()) this.#sendSubscribe(schema, symbols);
  }

  #onText(data: string): void {
    let parsed: unknown;
    try {
      parsed = parseJsonLossless(data);
    } catch {
      this.#health.recordFailure(new TransportError('polygon sent a non-JSON frame'));
      return;
    }

    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const emitted: MarketMessage[] = [];

    for (const entry of batch) {
      if (typeof entry !== 'object' || entry === null) continue;
      const msg = entry as Record<string, unknown>;

      if (msg['ev'] === 'status') {
        this.#onStatus(msg);
        continue;
      }
      try {
        const normalized = normalizePolygonMessage(msg, this.#normalizeOptions());
        if (normalized) emitted.push(normalized);
      } catch (error) {
        // A vendor shape change degrades health but never kills the consumer's stream.
        this.#health.recordFailure(error);
      }
    }

    if (emitted.length === 0) return;
    this.#health.recordMessage(emitted.length);
    for (const message of emitted) {
      for (const consumer of this.#consumers) {
        if (consumer.schema === schemaOf(message) && consumer.symbols.has(message.symbol)) {
          consumer.queue.push(message);
        }
      }
    }
  }

  #onStatus(msg: Record<string, unknown>): void {
    const status = String(msg['status'] ?? '');
    const message = redact(String(msg['message'] ?? ''));

    switch (status) {
      case 'auth_success': {
        this.#authenticated = true;
        this.#resubscribeAll();
        return;
      }
      case 'auth_failed':
      case 'auth_timeout': {
        this.#socket?.fail(
          new AuthError(`polygon auth failed: ${message}`, { provider: PROVIDER }),
        );
        return;
      }
      case 'max_connections': {
        this.#socket?.fail(
          new RateLimitError(`polygon connection limit reached: ${message}`, {
            provider: PROVIDER,
          }),
        );
        return;
      }
      case 'error': {
        this.#health.recordFailure(new TransportError(`polygon: ${message}`, { provider: PROVIDER }));
        return;
      }
      default:
        // 'connected' and subscription acks need no action.
        return;
    }
  }
}

function schemaOf(message: MarketMessage): Schema {
  switch (message.kind) {
    case 'quote':
      return 'quote_l1';
    case 'trade':
      return 'trades';
    case 'bar':
      return message.interval === '1m' ? 'bars_1m' : 'bars_1d';
    case 'depth':
      return 'depth_10';
  }
}

/** `polygon({ apiKey })` in consumer config. */
export function polygon(options: PolygonOptions): ProviderAdapter {
  return new PolygonAdapter(options);
}

export { UNRESOLVED_FIGI, nowNs };
export type { PolygonAdapter };
export * from './normalize.js';
export * from './conditions.js';
