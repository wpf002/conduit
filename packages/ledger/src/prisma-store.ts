import type { Micros, ProviderId, Schema, UsageKind } from '@conduit/core';
import { micros } from '@conduit/core';
import type { PrismaClient } from '@conduit/db';
import type {
  LedgerStore,
  QuotaLimit,
  SpendDimension,
  SpendRow,
  StoredUsageEvent,
} from './store.js';

/**
 * Usage counters on the user's own Postgres. This data never leaves the machine — it is the record
 * of what the user's own keys did, and it is nobody else's business.
 */
export class PrismaLedgerStore implements LedgerStore {
  #db: PrismaClient;

  constructor(db: PrismaClient) {
    this.#db = db;
  }

  async append(events: readonly StoredUsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.#db.usageEvent.createMany({
      data: events.map((event) => ({
        provider: event.provider,
        kind: event.kind,
        schema: event.schema ?? null,
        figi: event.figi ?? null,
        count: event.count,
        costMicro: event.costMicro,
        occurredAt: event.occurredAt,
      })),
    });
  }

  async spend(since: Date, by: SpendDimension): Promise<readonly SpendRow[]> {
    // groupBy has no 'symbol' column: UsageEvent stores figi, because a symbol is a per-vendor
    // alias and grouping by it would split one instrument across spellings.
    const field = by === 'symbol' ? 'figi' : by;
    const rows = await this.#db.usageEvent.groupBy({
      by: [field],
      where: { occurredAt: { gte: since } },
      _sum: { count: true, costMicro: true },
      _count: { _all: true },
    });

    return rows
      .map((row) => ({
        key: String((row as Record<string, unknown>)[field] ?? '(none)'),
        events: row._count._all,
        units: row._sum.count ?? 0,
        costMicro: row._sum.costMicro ?? 0,
      }))
      .sort((a, b) => b.units - a.units || a.key.localeCompare(b.key));
  }

  async countSince(provider: ProviderId, kind: UsageKind, since: Date): Promise<number> {
    const result = await this.#db.usageEvent.aggregate({
      where: { provider, kind, occurredAt: { gte: since } },
      _sum: { count: true },
    });
    return result._sum.count ?? 0;
  }

  async getQuota(provider: ProviderId): Promise<QuotaLimit | null> {
    const row = await this.#db.providerQuota.findUnique({ where: { provider } });
    if (!row) return null;
    return {
      provider: row.provider as ProviderId,
      windowSec: row.windowSec,
      maxRequests: row.maxRequests ?? undefined,
      maxMessages: row.maxMessages ?? undefined,
      monthlyCents: row.monthlyCents ?? undefined,
    };
  }

  async setQuota(limit: QuotaLimit): Promise<void> {
    const data = {
      windowSec: limit.windowSec,
      maxRequests: limit.maxRequests ?? null,
      maxMessages: limit.maxMessages ?? null,
      monthlyCents: limit.monthlyCents ?? null,
    };
    await this.#db.providerQuota.upsert({
      where: { provider: limit.provider },
      create: { provider: limit.provider, ...data },
      update: data,
    });
  }

  async size(): Promise<number> {
    return this.#db.usageEvent.count();
  }
}

export function asMicros(value: number): Micros {
  return micros(value);
}

export type { Schema };
