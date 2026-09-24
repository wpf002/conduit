import type { AssetClass, Instrument, ProviderId } from '@conduit/core';
import { canonicalKey, symbolVariants } from './variants.js';

export interface SymbolMapping {
  readonly figi: string;
  readonly provider: string;
  readonly symbol: string;
  readonly validFrom: Date;
  /** null means still current. */
  readonly validTo: Date | null;
}

export interface NegativeEntry {
  readonly symbol: string;
  readonly provider: string | undefined;
  readonly assetClass: AssetClass | undefined;
  readonly reason: string;
  readonly attempts: number;
  readonly expiresAt: Date;
}

export interface ResolveQuery {
  readonly symbol: string;
  readonly provider?: ProviderId;
  /** Point in time the symbol should be interpreted at. */
  readonly asOf: Date;
}

export interface SymbologyStore {
  getInstrument(figi: string): Promise<Instrument | null>;
  /** The instrument this symbol referred to on asOf, not the one it refers to today. */
  resolveSymbol(query: ResolveQuery): Promise<Instrument | null>;
  save(instrument: Instrument, mappings: readonly SymbolMapping[]): Promise<void>;
  /** Ends a mapping's validity, which is how a ticker change is recorded. */
  closeMapping(figi: string, provider: string, symbol: string, validTo: Date): Promise<void>;
  mappingsFor(figi: string): Promise<readonly SymbolMapping[]>;
  /**
   * Returns the entry whether or not it has expired. Expiry is the resolver's decision, because
   * the resolver is the thing that has a clock — a store comparing against its own Date.now()
   * disagrees with an injected clock and silently disables the cache.
   */
  getNegative(
    symbol: string,
    provider: ProviderId | undefined,
    assetClass: AssetClass | undefined,
  ): Promise<NegativeEntry | null>;
  saveNegative(entry: NegativeEntry): Promise<void>;
  clearNegative(symbol: string, provider: ProviderId | undefined): Promise<void>;
  /** Instruments not re-resolved since `before`, for the nightly refresh. */
  staleInstruments(before: Date, limit: number): Promise<readonly Instrument[]>;
  markResolved(figi: string, at: Date): Promise<void>;
  setActive(figi: string, active: boolean): Promise<void>;
}

function negativeKey(
  symbol: string,
  provider: ProviderId | undefined,
  assetClass: AssetClass | undefined,
): string {
  return `${provider ?? '*'}|${canonicalKey(symbol)}|${assetClass ?? '*'}`;
}

function covers(mapping: SymbolMapping, asOf: Date): boolean {
  if (mapping.validFrom.getTime() > asOf.getTime()) return false;
  return mapping.validTo === null || mapping.validTo.getTime() > asOf.getTime();
}

/**
 * The store without Postgres. Conduit works with whichever subset of infrastructure the user has,
 * and this is also what the tests run against, so the temporal logic is exercised in one place
 * rather than twice.
 */
export class MemorySymbologyStore implements SymbologyStore {
  #instruments = new Map<string, Instrument>();
  #mappings: SymbolMapping[] = [];
  #negative = new Map<string, NegativeEntry>();
  #resolvedAt = new Map<string, Date>();

  async getInstrument(figi: string): Promise<Instrument | null> {
    return this.#instruments.get(figi) ?? null;
  }

  async resolveSymbol(query: ResolveQuery): Promise<Instrument | null> {
    const wanted = new Set(symbolVariants(query.symbol).map(canonicalKey));
    const candidates = this.#mappings.filter(
      (m) =>
        wanted.has(canonicalKey(m.symbol)) &&
        (query.provider === undefined || m.provider === query.provider) &&
        covers(m, query.asOf),
    );
    // The most recently opened mapping wins, which matters for a ticker reused after a delisting.
    candidates.sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
    const best = candidates[0];
    return best ? (this.#instruments.get(best.figi) ?? null) : null;
  }

  async save(instrument: Instrument, mappings: readonly SymbolMapping[]): Promise<void> {
    this.#instruments.set(instrument.figi, instrument);
    this.#resolvedAt.set(instrument.figi, new Date());
    for (const mapping of mappings) {
      const existing = this.#mappings.findIndex(
        (m) =>
          m.figi === mapping.figi &&
          m.provider === mapping.provider &&
          canonicalKey(m.symbol) === canonicalKey(mapping.symbol) &&
          m.validFrom.getTime() === mapping.validFrom.getTime(),
      );
      if (existing === -1) this.#mappings.push(mapping);
      else this.#mappings[existing] = mapping;
    }
  }

  async closeMapping(
    figi: string,
    provider: string,
    symbol: string,
    validTo: Date,
  ): Promise<void> {
    for (const [i, mapping] of this.#mappings.entries()) {
      if (
        mapping.figi === figi &&
        mapping.provider === provider &&
        canonicalKey(mapping.symbol) === canonicalKey(symbol) &&
        mapping.validTo === null
      ) {
        this.#mappings[i] = { ...mapping, validTo };
      }
    }
  }

  async mappingsFor(figi: string): Promise<readonly SymbolMapping[]> {
    return this.#mappings.filter((m) => m.figi === figi);
  }

  async getNegative(
    symbol: string,
    provider: ProviderId | undefined,
    assetClass: AssetClass | undefined,
  ): Promise<NegativeEntry | null> {
    return this.#negative.get(negativeKey(symbol, provider, assetClass)) ?? null;
  }

  async saveNegative(entry: NegativeEntry): Promise<void> {
    this.#negative.set(negativeKey(entry.symbol, entry.provider as ProviderId, entry.assetClass), entry);
  }

  async clearNegative(symbol: string, provider: ProviderId | undefined): Promise<void> {
    for (const key of [...this.#negative.keys()]) {
      if (key.startsWith(`${provider ?? '*'}|${canonicalKey(symbol)}|`)) this.#negative.delete(key);
    }
  }

  async staleInstruments(before: Date, limit: number): Promise<readonly Instrument[]> {
    const out: Instrument[] = [];
    for (const [figi, instrument] of this.#instruments) {
      const at = this.#resolvedAt.get(figi);
      if (!at || at.getTime() < before.getTime()) out.push(instrument);
      if (out.length >= limit) break;
    }
    return out;
  }

  async markResolved(figi: string, at: Date): Promise<void> {
    this.#resolvedAt.set(figi, at);
  }

  async setActive(figi: string, active: boolean): Promise<void> {
    const instrument = this.#instruments.get(figi);
    if (instrument) this.#instruments.set(figi, { ...instrument, active });
  }

  get size(): number {
    return this.#instruments.size;
  }
}
