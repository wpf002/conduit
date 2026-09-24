import {
  HealthTracker,
  UNRESOLVED_FIGI,
  nowNs,
  type AssetClass,
  type CdmMessage,
  type HealthSnapshot,
  type ProviderAdapter,
  type ProviderId,
  type QuoteTick,
  type Schema,
  type SnapshotRequest,
  type StreamRequest,
} from '@conduit/core';
import { AsyncQueue } from '@conduit/providers';

export interface FakeAdapterOptions {
  readonly capabilities?: readonly Schema[];
  readonly assetClasses?: readonly AssetClass[];
  readonly staleAfterMs?: number;
  readonly maxConsecutiveFailures?: number;
  /** Simulated snapshot latency, for the lowest-latency strategy. */
  readonly snapshotLatencyMs?: number;
  readonly snapshotError?: Error;
  /** Throws synchronously from stream(), the way a CoverageError from a real adapter would. */
  readonly streamError?: Error;
}

/**
 * A provider adapter that does exactly what the test tells it to. The point of the Phase 2
 * acceptance test is the router's behaviour, so the provider has to be controllable rather than
 * merely mocked.
 */
export class FakeAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ReadonlySet<Schema>;

  #assetClasses: ReadonlySet<AssetClass>;
  #health: HealthTracker;
  #queues = new Set<AsyncQueue<CdmMessage>>();
  #options: FakeAdapterOptions;

  streamCalls = 0;
  snapshotCalls = 0;
  closed = false;

  constructor(id: ProviderId, options: FakeAdapterOptions = {}) {
    this.id = id;
    this.#options = options;
    this.capabilities = new Set(options.capabilities ?? ['quote_l1', 'trades', 'bars_1m']);
    this.#assetClasses = new Set(options.assetClasses ?? ['equity', 'etf']);
    this.#health = new HealthTracker({
      provider: id,
      staleAfterMs: options.staleAfterMs ?? 10_000,
      maxConsecutiveFailures: options.maxConsecutiveFailures ?? 3,
    });
  }

  health(): HealthSnapshot {
    return this.#health.snapshot();
  }

  supports(schema: Schema, assetClass: AssetClass): boolean {
    return this.capabilities.has(schema) && this.#assetClasses.has(assetClass);
  }

  async snapshot(req: SnapshotRequest): Promise<QuoteTick[]> {
    this.snapshotCalls += 1;
    if (this.#options.snapshotLatencyMs) {
      await new Promise((r) => setTimeout(r, this.#options.snapshotLatencyMs));
    }
    if (this.#options.snapshotError) {
      this.#health.recordFailure(this.#options.snapshotError);
      throw this.#options.snapshotError;
    }
    this.#health.recordMessage(req.symbols.length);
    return req.symbols.map((symbol) => this.quote(symbol, 1n));
  }

  stream(req: StreamRequest): AsyncIterable<CdmMessage> {
    this.streamCalls += 1;
    if (this.#options.streamError) throw this.#options.streamError;

    const queue = new AsyncQueue<CdmMessage>();
    this.#queues.add(queue);
    this.#health.recordConnected();
    if (req.signal) {
      req.signal.addEventListener('abort', () => queue.end(), { once: true });
    }

    const queues = this.#queues;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const message of queue) yield message;
        } finally {
          queues.delete(queue);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const queue of this.#queues) queue.end();
    this.#queues.clear();
    this.#health.recordDisconnected();
  }

  // ------------------------------------------------------------- test controls
  quote(symbol: string, tsEventNs: bigint, bidPx = 100): QuoteTick {
    return {
      kind: 'quote',
      figi: UNRESOLVED_FIGI,
      symbol,
      provider: this.id,
      tsEvent: tsEventNs,
      tsConduitRecv: nowNs(),
      bidPx,
      bidSz: 100,
      askPx: bidPx + 0.01,
      askSz: 100,
    };
  }

  /** Pushes a message to every open stream, exactly as a live socket frame would. */
  emit(message: CdmMessage): void {
    this.#health.recordMessage();
    for (const queue of this.#queues) queue.push(message);
  }

  emitQuote(symbol: string, tsEventNs: bigint, bidPx = 100): void {
    this.emit(this.quote(symbol, tsEventNs, bidPx));
  }

  /** The revoked-key case: every open stream throws and the provider stops serving. */
  failNow(error: Error): void {
    this.#health.recordFailure(error);
    for (const queue of this.#queues) queue.fail(error);
    this.#queues.clear();
  }

  /** A socket that closed without an error. */
  endNow(): void {
    this.#health.recordDisconnected();
    for (const queue of this.#queues) queue.end();
    this.#queues.clear();
  }

  recordFailures(count: number, error = new Error('synthetic failure')): void {
    for (let i = 0; i < count; i += 1) this.#health.recordFailure(error);
  }

  get openStreams(): number {
    return this.#queues.size;
  }
}
