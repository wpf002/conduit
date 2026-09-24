import type { AssetClass, Instrument, ProviderId } from '@conduit/core';
import type { PrismaClient } from '@conduit/db';
import { canonicalKey, symbolVariants } from './variants.js';
import type { NegativeEntry, ResolveQuery, SymbolMapping, SymbologyStore } from './store.js';

/** Sentinel for "any provider" / "any asset class" in the negative cache's unique key. */
const ANY = '*';

interface InstrumentRow {
  figi: string;
  ticker: string;
  name: string | null;
  assetClass: string;
  exchangeMic: string | null;
  currency: string;
  active: boolean;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    figi: row.figi,
    ticker: row.ticker,
    ...(row.name === null ? {} : { name: row.name }),
    assetClass: row.assetClass as AssetClass,
    ...(row.exchangeMic === null ? {} : { exchangeMic: row.exchangeMic }),
    currency: row.currency,
    active: row.active,
  };
}

/**
 * The symbology cache on the user's own Postgres. Nothing here is transmitted anywhere; it is a
 * local security master, and the only reason it is a database rather than a file is the temporal
 * query.
 */
export class PrismaSymbologyStore implements SymbologyStore {
  #db: PrismaClient;

  constructor(db: PrismaClient) {
    this.#db = db;
  }

  async getInstrument(figi: string): Promise<Instrument | null> {
    const row = await this.#db.instrument.findUnique({ where: { figi } });
    return row ? toInstrument(row) : null;
  }

  async resolveSymbol(query: ResolveQuery): Promise<Instrument | null> {
    const variants = symbolVariants(query.symbol);
    const rows = await this.#db.symbolMap.findMany({
      where: {
        symbol: { in: variants },
        ...(query.provider ? { provider: query.provider } : {}),
        validFrom: { lte: query.asOf },
        OR: [{ validTo: null }, { validTo: { gt: query.asOf } }],
      },
      orderBy: { validFrom: 'desc' },
      take: 1,
      include: { instrument: true },
    });
    const row = rows[0];
    return row ? toInstrument(row.instrument) : null;
  }

  async save(instrument: Instrument, mappings: readonly SymbolMapping[]): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      const data = {
        ticker: instrument.ticker,
        name: instrument.name ?? null,
        assetClass: instrument.assetClass,
        exchangeMic: instrument.exchangeMic ?? null,
        currency: instrument.currency,
        active: instrument.active,
        resolvedAt: new Date(),
      };
      await tx.instrument.upsert({
        where: { figi: instrument.figi },
        create: { figi: instrument.figi, ...data },
        update: data,
      });
      for (const mapping of mappings) {
        await tx.symbolMap.upsert({
          where: {
            provider_symbol_validFrom: {
              provider: mapping.provider,
              symbol: mapping.symbol,
              validFrom: mapping.validFrom,
            },
          },
          create: {
            figi: mapping.figi,
            provider: mapping.provider,
            symbol: mapping.symbol,
            validFrom: mapping.validFrom,
            validTo: mapping.validTo,
          },
          update: { figi: mapping.figi, validTo: mapping.validTo },
        });
      }
    });
  }

  async closeMapping(
    figi: string,
    provider: string,
    symbol: string,
    validTo: Date,
  ): Promise<void> {
    await this.#db.symbolMap.updateMany({
      where: { figi, provider, symbol: { in: symbolVariants(symbol) }, validTo: null },
      data: { validTo },
    });
  }

  async mappingsFor(figi: string): Promise<readonly SymbolMapping[]> {
    const rows = await this.#db.symbolMap.findMany({ where: { figi } });
    return rows.map((row) => ({
      figi: row.figi,
      provider: row.provider,
      symbol: row.symbol,
      validFrom: row.validFrom,
      validTo: row.validTo,
    }));
  }

  async getNegative(
    symbol: string,
    provider: ProviderId | undefined,
    assetClass: AssetClass | undefined,
  ): Promise<NegativeEntry | null> {
    const row = await this.#db.unresolvedSymbol.findFirst({
      where: {
        symbol: canonicalKey(symbol),
        provider: provider ?? ANY,
        assetClass: assetClass ?? ANY,
      },
    });
    if (!row) return null;
    return {
      symbol: row.symbol,
      provider: row.provider === ANY ? undefined : (row.provider as ProviderId),
      assetClass: row.assetClass === ANY ? undefined : (row.assetClass as AssetClass),
      reason: row.reason,
      attempts: row.attempts,
      expiresAt: row.expiresAt,
    };
  }

  async saveNegative(entry: NegativeEntry): Promise<void> {
    const key = {
      provider: entry.provider ?? ANY,
      symbol: canonicalKey(entry.symbol),
      assetClass: entry.assetClass ?? ANY,
    };
    await this.#db.unresolvedSymbol.upsert({
      where: { provider_symbol_assetClass: key },
      create: {
        ...key,
        reason: entry.reason,
        attempts: entry.attempts,
        expiresAt: entry.expiresAt,
      },
      update: {
        reason: entry.reason,
        attempts: { increment: 1 },
        lastTriedAt: new Date(),
        expiresAt: entry.expiresAt,
      },
    });
  }

  async clearNegative(symbol: string, provider: ProviderId | undefined): Promise<void> {
    await this.#db.unresolvedSymbol.deleteMany({
      where: { symbol: canonicalKey(symbol), ...(provider ? { provider } : {}) },
    });
  }

  async staleInstruments(before: Date, limit: number): Promise<readonly Instrument[]> {
    const rows = await this.#db.instrument.findMany({
      where: { resolvedAt: { lt: before } },
      orderBy: { resolvedAt: 'asc' },
      take: limit,
    });
    return rows.map(toInstrument);
  }

  async markResolved(figi: string, at: Date): Promise<void> {
    await this.#db.instrument.update({ where: { figi }, data: { resolvedAt: at } });
  }

  async setActive(figi: string, active: boolean): Promise<void> {
    await this.#db.instrument.update({ where: { figi }, data: { active } });
  }
}
