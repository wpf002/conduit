import {
  nsToDate,
  type Micros,
  type ProviderId,
  type UsageKind,
  type UsageRecord,
  type UsageHooks,
  type UsageSink,
} from '@conduit/core';
import { DEFAULT_COST_MODEL, costOf, mergeCostModel, type CostModel } from './cost.js';
import { MemoryLedgerStore, type LedgerStore, type SpendDimension, type SpendRow, type StoredUsageEvent } from './store.js';
import { RateLimitGovernor, type GovernorOptions, type Headroom } from './governor.js';

export interface LedgerOptions {
  readonly store?: LedgerStore;
  readonly costModel?: CostModel;
  readonly governor?: RateLimitGovernor | GovernorOptions;
  /** Events buffered before a write. A tick-rate feed must not be one insert per message. */
  readonly batchSize?: number;
  /** Maximum time an event waits in the buffer. */
  readonly flushIntervalMs?: number;
}

export interface LedgerTotals {
  readonly buffered: number;
  readonly written: number;
  readonly costMicro: number;
}

/**
 * Counts what the user's own keys did and what it cost them. Writes to the user's local store and
 * is never transmitted anywhere.
 *
 * The sink is synchronous and buffered, because it is called once per message on a tick feed.
 */
export class UsageLedger {
  #store: LedgerStore;
  #costModel: CostModel;
  #governor: RateLimitGovernor;
  #batchSize: number;
  #flushIntervalMs: number;
  #buffer: StoredUsageEvent[] = [];
  #timer: NodeJS.Timeout | undefined;
  #written = 0;
  #costMicro = 0;
  #inFlight: Promise<void> | undefined;

  constructor(options: LedgerOptions = {}) {
    this.#store = options.store ?? new MemoryLedgerStore();
    this.#costModel = mergeCostModel(DEFAULT_COST_MODEL, options.costModel);
    this.#governor =
      options.governor instanceof RateLimitGovernor
        ? options.governor
        : new RateLimitGovernor(options.governor ?? {});
    this.#batchSize = options.batchSize ?? 500;
    this.#flushIntervalMs = options.flushIntervalMs ?? 5_000;
  }

  get governor(): RateLimitGovernor {
    return this.#governor;
  }

  get store(): LedgerStore {
    return this.#store;
  }

  get costModel(): CostModel {
    return this.#costModel;
  }

  /** Hand this to an adapter's onUsage option. Never throws, never blocks. */
  get sink(): UsageSink {
    return (record) => this.record(record);
  }

  record(record: UsageRecord): void {
    const costMicro = costOf(record, this.#costModel);
    this.#costMicro += costMicro;
    this.#governor.record(record.provider, record.kind, record.count);
    this.#buffer.push({
      provider: record.provider,
      kind: record.kind,
      schema: record.schema,
      figi: record.figi,
      symbol: record.symbol,
      count: record.count,
      costMicro: costMicro as Micros,
      occurredAt: nsToDate(record.atNs),
    });

    if (this.#buffer.length >= this.#batchSize) {
      void this.flush();
      return;
    }
    this.#scheduleFlush();
  }

  /** The hooks an adapter takes, bound to one provider. */
  hooksFor(provider: ProviderId): UsageHooks {
    return {
      sink: this.sink,
      acquire: (kind, units) => this.#governor.acquire(provider, kind, units),
    };
  }

  /** Reserves quota before a call the caller is about to make. */
  async acquire(provider: ProviderId, kind: UsageKind, units = 1): Promise<void> {
    await this.#governor.acquire(provider, kind, units);
  }

  headroom(provider: ProviderId, kind: UsageKind = 'rest'): Headroom {
    return this.#governor.headroom(provider, kind);
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#buffer.length === 0) return this.#inFlight ?? Promise.resolve();

    const batch = this.#buffer;
    this.#buffer = [];
    // Serialize writes so a burst cannot interleave two createMany calls out of order.
    const previous = this.#inFlight ?? Promise.resolve();
    this.#inFlight = previous
      .then(() => this.#store.append(batch))
      .then(() => {
        this.#written += batch.length;
      })
      .catch(() => {
        // A failed write must not lose the events or throw into the data path.
        this.#buffer.unshift(...batch);
      });
    return this.#inFlight;
  }

  async spend(since: Date, by: SpendDimension = 'provider'): Promise<readonly SpendRow[]> {
    await this.flush();
    return this.#store.spend(since, by);
  }

  totals(): LedgerTotals {
    return { buffered: this.#buffer.length, written: this.#written, costMicro: this.#costMicro };
  }

  async close(): Promise<void> {
    await this.flush();
    await this.#inFlight;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #scheduleFlush(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#flushIntervalMs);
    this.#timer.unref?.();
  }
}
