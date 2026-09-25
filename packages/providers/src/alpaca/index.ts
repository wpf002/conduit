import { request } from 'undici';
import {
  AuthError,
  CoverageError,
  HealthTracker,
  RateLimitError,
  SchemaError,
  TransportError,
  isoToNs,
  nowNs,
  redact,
  createLogger,
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
  type Logger,
  type UsageHooks,
} from '@conduit/core';
import { ConsumerSet } from '../fanout.js';
import { ReconnectingSocket } from '../ws.js';
import { SubscriptionRegistry } from '../subscriptions.js';
import { parseJsonLossless } from '../json.js';
import { normalizeAlpacaMessage } from './normalize.js';

const PROVIDER = 'alpaca' as const;

const CAPABILITIES: ReadonlySet<Schema> = new Set<Schema>([
  'quote_l1',
  'trades',
  'bars_1m',
  'bars_1d',
]);

const SUPPORTED_ASSET_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>(['equity', 'etf']);

/** The subscribe frame uses a named array per schema rather than a channel string. */
const SUBSCRIBE_KEY: Readonly<Record<string, string>> = {
  quote_l1: 'quotes',
  trades: 'trades',
  bars_1m: 'bars',
  bars_1d: 'dailyBars',
};

/**
 * Alpaca's published websocket error codes. The mapping matters because the router dispatches on the
 * error class: an entitlement problem must not be retried, a connection cap must, and a feed that
 * cannot serve a subscription is a coverage gap rather than a dead key.
 *
 * Returning undefined means the code is benign and should not count as a failure.
 */
function errorForCode(
  code: number,
  message: string,
): AuthError | RateLimitError | CoverageError | TransportError | SchemaError | undefined {
  switch (code) {
    // "invalid syntax" — Conduit sent a malformed frame. Retrying sends it again.
    case 400:
      return new SchemaError(`alpaca rejected our frame (400): ${message}`, { provider: PROVIDER });
    case 401: // not authenticated
    case 402: // auth failed
    case 404: // auth timeout
      return new AuthError(`alpaca auth failed (${code}): ${message}`, { provider: PROVIDER });
    // "already authenticated" — harmless, and counting it as a failure would degrade a healthy feed.
    case 403:
      return undefined;
    // "symbol limit exceeded" is a subscription cap, not a rate: the free plan allows 30 symbols.
    // Retrying cannot help, so it has to read as a coverage gap for failover to do the right thing.
    case 405:
      return new CoverageError(`alpaca symbol limit exceeded (405): ${message}`, {
        provider: PROVIDER,
      });
    case 406: // connection limit exceeded
      return new RateLimitError(`alpaca connection limit reached (406): ${message}`, {
        provider: PROVIDER,
      });
    case 407: // slow client — our consumer could not keep up
      return new TransportError(`alpaca dropped us as a slow client (407): ${message}`, {
        provider: PROVIDER,
      });
    case 409: // insufficient subscription
      return new AuthError(`alpaca plan does not cover this feed (409): ${message}`, {
        provider: PROVIDER,
      });
    // "invalid subscribe action for this feed" — the key is fine, the feed cannot serve it.
    case 410:
      return new CoverageError(`alpaca feed rejected the subscription (410): ${message}`, {
        provider: PROVIDER,
      });
    default:
      return new TransportError(`alpaca stream error (${code}): ${message}`, {
        provider: PROVIDER,
      });
  }
}

export interface AlpacaOptions {
  readonly keyId: string;
  readonly secret: string;
  /** 'iex' is the free feed, 'sip' the paid consolidated tape, 'delayed_sip' the 15-minute one. */
  readonly feed?: 'iex' | 'sip' | 'delayed_sip';
  readonly wsUrl?: string;
  readonly restBaseUrl?: string;
  readonly staleAfterMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly backoff?: BackoffOptions;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly highWaterMark?: number;
  readonly resolveFigi?: (symbol: string) => string;
  readonly quoteSizeUnits?: 'lots' | 'shares';
  readonly includeRaw?: boolean;
  /** Quota accounting. Hand it `ledger.hooksFor('alpaca')`. */
  readonly usage?: UsageHooks;
  /** Diagnostics. Without one the adapter is silent. */
  readonly logger?: Logger;
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Test seam. Production code never passes this. */
  readonly socketFactory?: ConstructorParameters<typeof ReconnectingSocket>[1];
}

class AlpacaAdapter implements ProviderAdapter {
  readonly id = PROVIDER;
  readonly capabilities = CAPABILITIES;

  #options: AlpacaOptions;
  #health: HealthTracker;
  #registry = new SubscriptionRegistry();
  #consumers = new ConsumerSet();
  #socket: ReconnectingSocket | undefined;
  #authenticated = false;
  #closed = false;
  #log: Logger;

  constructor(options: AlpacaOptions) {
    if (!options.keyId || !options.secret) {
      throw new AuthError('alpaca: keyId and secret are required', { provider: PROVIDER });
    }
    registerSecret(options.keyId);
    registerSecret(options.secret);
    this.#options = options;
    this.#log = createLogger(options.logger, {
      ...(options.logLevel ? { level: options.logLevel } : {}),
    });
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
      throw new CoverageError(`alpaca adapter covers US equities and ETFs, not ${assetClass}`, {
        provider: PROVIDER,
        schema,
        assetClass,
      });
    }
    if (!CAPABILITIES.has(schema)) {
      throw new CoverageError(`alpaca has no ${schema} feed`, {
        provider: PROVIDER,
        schema,
        assetClass,
      });
    }
  }

  async snapshot(req: SnapshotRequest): Promise<QuoteTick[]> {
    const assetClass = req.assetClass ?? 'equity';
    this.#assertSupported('quote_l1', assetClass);
    if (req.symbols.length === 0) return [];

    // Reserve before the call, so a local refusal replaces a 429.
    await this.#options.usage?.acquire?.('rest', 1);

    const base = this.#options.restBaseUrl ?? 'https://data.alpaca.markets';
    const url = new URL('/v2/stocks/quotes/latest', base);
    url.searchParams.set('symbols', req.symbols.join(','));
    url.searchParams.set('feed', this.#options.feed ?? 'iex');

    let res;
    try {
      res = await request(url, {
        method: 'GET',
        headers: {
          'APCA-API-KEY-ID': this.#options.keyId,
          'APCA-API-SECRET-KEY': this.#options.secret,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      const err = new TransportError(
        `alpaca snapshot request failed: ${redact(error instanceof Error ? error.message : String(error))}`,
        { provider: PROVIDER, cause: error },
      );
      this.#health.recordFailure(err);
      throw err;
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      const err = new AuthError('alpaca rejected the credentials on snapshot', {
        provider: PROVIDER,
      });
      this.#health.recordFailure(err);
      throw err;
    }
    if (res.statusCode === 429) {
      const retryAfter = Number(res.headers['retry-after']);
      const err = new RateLimitError('alpaca snapshot rate limited', {
        provider: PROVIDER,
        ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
      });
      this.#health.recordFailure(err);
      throw err;
    }
    if (res.statusCode >= 400) {
      const err = new TransportError(`alpaca snapshot HTTP ${res.statusCode}`, {
        provider: PROVIDER,
      });
      this.#health.recordFailure(err);
      throw err;
    }

    const body = parseJsonLossless(await res.body.text()) as {
      quotes?: Record<string, Record<string, unknown>>;
    };
    const out: QuoteTick[] = [];
    for (const [symbol, quote] of Object.entries(body.quotes ?? {})) {
      // The REST shape omits T and S, which the stream normalizer needs.
      const normalized = normalizeAlpacaMessage(
        { ...quote, T: 'q', S: symbol },
        this.#normalizeOptions(),
      );
      if (normalized && normalized.kind === 'quote') out.push(normalized);
    }
    this.#health.recordMessage(out.length);
    this.#reportUsage('rest', 1, 'quote_l1');
    return out;
  }

  stream(req: StreamRequest): AsyncIterable<CdmMessage> {
    const assetClass = req.assetClass ?? 'equity';
    this.#assertSupported(req.schema, assetClass);
    if (req.start !== undefined || req.end !== undefined) {
      throw new CoverageError('alpaca adapter streams live only; use snapshot for point-in-time', {
        provider: PROVIDER,
        schema: req.schema,
      });
    }
    if (this.#closed) {
      throw new TransportError('alpaca adapter is closed', { provider: PROVIDER });
    }

    const consumer = this.#consumers.add(
      req.schema,
      req.symbols,
      this.#options.highWaterMark ?? 100_000,
      PROVIDER,
    );

    const added = this.#registry.add(req.schema, req.symbols);
    this.#ensureSocket();
    if (this.#authenticated && added.length > 0) this.#sendSubscribe(req.schema, added, 'subscribe');

    const detach = (): void => {
      const orphaned = this.#consumers.remove(consumer);
      if (orphaned.length > 0) {
        this.#registry.remove(req.schema, orphaned);
        this.#sendSubscribe(req.schema, orphaned, 'unsubscribe');
      }
    };

    if (req.signal) {
      if (req.signal.aborted) consumer.queue.end();
      else
        req.signal.addEventListener('abort', () => consumer.queue.end(), { once: true });
    }

    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const message of consumer.queue) yield message;
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
    this.#consumers.endAll();
    await this.#teardownSocket();
  }

  #reportUsage(kind: 'rest' | 'ws_message' | 'ws_subscribe', count: number, schema?: Schema): void {
    const sink = this.#options.usage?.sink;
    if (!sink || count === 0) return;
    try {
      sink({
        provider: PROVIDER,
        kind,
        count,
        atNs: nowNs(),
        ...(schema ? { schema } : {}),
      });
    } catch {
      /* accounting never breaks the data path */
    }
  }

  #normalizeOptions() {
    return {
      ...(this.#options.resolveFigi ? { resolveFigi: this.#options.resolveFigi } : {}),
      ...(this.#options.quoteSizeUnits ? { quoteSizeUnits: this.#options.quoteSizeUnits } : {}),
      ...(this.#options.includeRaw === undefined ? {} : { includeRaw: this.#options.includeRaw }),
    };
  }

  #ensureSocket(): void {
    if (this.#socket) return;
    const feed = this.#options.feed ?? 'iex';
    this.#socket = new ReconnectingSocket(
      {
        url: this.#options.wsUrl ?? `wss://stream.data.alpaca.markets/v2/${feed}`,
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
          ctx.send(
            JSON.stringify({
              action: 'auth',
              key: this.#options.keyId,
              secret: this.#options.secret,
            }),
          );
        },
        onText: (data) => this.#onText(data),
        logger: this.#log,
        onFatal: (error) => {
          this.#consumers.failAll(error);
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

  #sendSubscribe(
    schema: Schema,
    symbols: readonly string[],
    action: 'subscribe' | 'unsubscribe',
  ): void {
    if (symbols.length === 0 || !this.#socket) return;
    const key = SUBSCRIBE_KEY[schema];
    if (!key) return;
    if (action === 'subscribe') this.#reportUsage('ws_subscribe', symbols.length, schema);
    this.#socket.send(JSON.stringify({ action, [key]: [...symbols] }));
  }

  #resubscribeAll(): void {
    for (const { schema, symbols } of this.#registry.all()) {
      this.#sendSubscribe(schema, symbols, 'subscribe');
    }
  }

  #onText(data: string): void {
    let parsed: unknown;
    try {
      parsed = parseJsonLossless(data);
    } catch {
      this.#health.recordFailure(new TransportError('alpaca sent a non-JSON frame'));
      return;
    }

    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const emitted: MarketMessage[] = [];

    for (const entry of batch) {
      if (typeof entry !== 'object' || entry === null) continue;
      const msg = entry as Record<string, unknown>;
      const type = msg['T'];

      if (type === 'success') {
        if (msg['msg'] === 'authenticated') {
          this.#log({ level: 'info', msg: 'authenticated', provider: PROVIDER });
          this.#authenticated = true;
          this.#resubscribeAll();
        }
        continue;
      }
      if (type === 'error') {
        const code = typeof msg['code'] === 'number' ? msg['code'] : 0;
        const error = errorForCode(code, redact(String(msg['msg'] ?? '')));
        // undefined means benign; recording it would degrade a healthy feed.
        if (error) {
          if (error.retryable) this.#health.recordFailure(error);
          else this.#socket?.fail(error);
        }
        continue;
      }
      if (type === 'subscription') continue;

      try {
        const normalized = normalizeAlpacaMessage(msg, this.#normalizeOptions());
        if (normalized) emitted.push(normalized);
      } catch (error) {
        this.#health.recordFailure(error);
      }
    }

    if (emitted.length === 0) return;
    this.#health.recordMessage(emitted.length);
    this.#reportUsage('ws_message', emitted.length);
    this.#consumers.dispatch(emitted);
  }
}

export function alpaca(options: AlpacaOptions): ProviderAdapter {
  return new AlpacaAdapter(options);
}

export { isoToNs };
export * from './normalize.js';
export * from './conditions.js';
