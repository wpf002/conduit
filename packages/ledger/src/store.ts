import type { Micros, ProviderId, Schema, UsageKind } from '@conduit/core';

export interface StoredUsageEvent {
  readonly provider: ProviderId;
  readonly kind: UsageKind;
  readonly schema: Schema | undefined;
  readonly figi: string | undefined;
  readonly symbol: string | undefined;
  readonly count: number;
  readonly costMicro: Micros;
  readonly occurredAt: Date;
}

export type SpendDimension = 'provider' | 'schema' | 'symbol' | 'kind';

export interface SpendRow {
  readonly key: string;
  readonly events: number;
  readonly units: number;
  readonly costMicro: number;
}

export interface QuotaLimit {
  readonly provider: ProviderId;
  readonly windowSec: number;
  readonly maxRequests: number | undefined;
  readonly maxMessages: number | undefined;
  readonly monthlyCents: number | undefined;
}

export interface LedgerStore {
  append(events: readonly StoredUsageEvent[]): Promise<void>;
  /** Grouped totals since a point in time. */
  spend(since: Date, by: SpendDimension): Promise<readonly SpendRow[]>;
  countSince(provider: ProviderId, kind: UsageKind, since: Date): Promise<number>;
  getQuota(provider: ProviderId): Promise<QuotaLimit | null>;
  setQuota(limit: QuotaLimit): Promise<void>;
  /** Total events held, for `conduit doctor`. */
  size(): Promise<number>;
}

function keyFor(event: StoredUsageEvent, by: SpendDimension): string {
  switch (by) {
    case 'provider':
      return event.provider;
    case 'schema':
      return event.schema ?? '(none)';
    case 'symbol':
      return event.symbol ?? '(none)';
    case 'kind':
      return event.kind;
  }
}

/** Usage accounting without Postgres. Also what the tests run against. */
export class MemoryLedgerStore implements LedgerStore {
  #events: StoredUsageEvent[] = [];
  #quotas = new Map<ProviderId, QuotaLimit>();

  async append(events: readonly StoredUsageEvent[]): Promise<void> {
    this.#events.push(...events);
  }

  async spend(since: Date, by: SpendDimension): Promise<readonly SpendRow[]> {
    const grouped = new Map<string, { events: number; units: number; costMicro: number }>();
    for (const event of this.#events) {
      if (event.occurredAt.getTime() < since.getTime()) continue;
      const key = keyFor(event, by);
      const row = grouped.get(key) ?? { events: 0, units: 0, costMicro: 0 };
      row.events += 1;
      row.units += event.count;
      row.costMicro += event.costMicro;
      grouped.set(key, row);
    }
    return [...grouped]
      .map(([key, row]) => ({ key, ...row }))
      .sort((a, b) => b.units - a.units || a.key.localeCompare(b.key));
  }

  async countSince(provider: ProviderId, kind: UsageKind, since: Date): Promise<number> {
    let total = 0;
    for (const event of this.#events) {
      if (event.provider !== provider || event.kind !== kind) continue;
      if (event.occurredAt.getTime() < since.getTime()) continue;
      total += event.count;
    }
    return total;
  }

  async getQuota(provider: ProviderId): Promise<QuotaLimit | null> {
    return this.#quotas.get(provider) ?? null;
  }

  async setQuota(limit: QuotaLimit): Promise<void> {
    this.#quotas.set(limit.provider, limit);
  }

  async size(): Promise<number> {
    return this.#events.length;
  }

  get events(): readonly StoredUsageEvent[] {
    return this.#events;
  }
}
