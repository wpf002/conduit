import {
  PROVIDER_IDS,
  UNRESOLVED_FIGI,
  isFigi,
  type AssetClass,
  type Instrument,
  type ProviderId,
} from '@conduit/core';
import { OpenFigiClient, type OpenFigiJob, type OpenFigiMatch } from './openfigi.js';
import { MemorySymbologyStore, type SymbolMapping, type SymbologyStore } from './store.js';
import { canonicalKey, toProviderSymbol } from './variants.js';

export interface ResolverOptions {
  readonly store?: SymbologyStore;
  /** Omitted means cache-only: nothing is resolved that is not already known. */
  readonly openFigi?: OpenFigiClient;
  /** How long an unresolvable symbol stays negatively cached. */
  readonly negativeTtlMs?: number;
  /**
   * How far back an asOf can be before a live OpenFIGI lookup is refused. OpenFIGI answers as of
   * today, so using it to resolve a historical date is how a backtest silently gets the wrong
   * instrument.
   */
  readonly historicalCutoffMs?: number;
  readonly now?: () => Date;
}

export interface ResolveOptions {
  readonly provider?: ProviderId;
  /** Skips the store and the negative cache and asks the vendor. Used by the nightly refresh. */
  readonly force?: boolean;
  /** Defaults to now. A past date is resolved from the store only. */
  readonly asOf?: Date;
  readonly assetClass?: AssetClass;
  readonly exchCode?: string;
  readonly currency?: string;
}

export interface ResolverStats {
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly negativeHits: number;
  readonly openFigiCalls: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly historicalRefusals: number;
  readonly inProcessSize: number;
}

const DAY_MS = 86_400_000;

function pickMatch(matches: readonly OpenFigiMatch[], assetClass: AssetClass | undefined): OpenFigiMatch | undefined {
  if (matches.length === 0) return undefined;
  // Prefer the US composite over a single venue listing: it is the identity a strategy means.
  const composite = matches.find((m) => m.figi === m.compositeFIGI);
  if (composite) return composite;
  if (assetClass === 'etf') {
    const etp = matches.find((m) => m.securityType === 'ETP' || m.marketSector === 'Equity');
    if (etp) return etp;
  }
  return matches[0];
}

function instrumentFrom(
  match: OpenFigiMatch,
  job: OpenFigiJob,
  assetClass: AssetClass,
): Instrument {
  return {
    figi: match.figi,
    ticker: match.ticker ?? job.symbol,
    ...(match.name ? { name: match.name } : {}),
    assetClass,
    ...(job.micCode ? { exchangeMic: job.micCode } : {}),
    currency: job.currency ?? 'USD',
    active: true,
  };
}

/**
 * FIGI is the internal primary key; every provider symbol is a per-vendor alias with a validity
 * window. Resolution order is: in-process map, store, then OpenFIGI, with unresolvable symbols
 * negatively cached so a bad ticker does not generate one request per tick.
 */
export class SymbologyResolver {
  #store: SymbologyStore;
  #openFigi: OpenFigiClient | undefined;
  #negativeTtlMs: number;
  #historicalCutoffMs: number;
  #now: () => Date;

  /** Synchronous cache the adapters read through their resolveFigi hook. */
  #inProcess = new Map<string, string>();
  #stats = {
    cacheHits: 0,
    cacheMisses: 0,
    negativeHits: 0,
    resolved: 0,
    unresolved: 0,
    historicalRefusals: 0,
  };

  constructor(options: ResolverOptions = {}) {
    this.#store = options.store ?? new MemorySymbologyStore();
    this.#openFigi = options.openFigi;
    this.#negativeTtlMs = options.negativeTtlMs ?? 6 * 60 * 60 * 1000;
    this.#historicalCutoffMs = options.historicalCutoffMs ?? DAY_MS;
    this.#now = options.now ?? (() => new Date());
  }

  get store(): SymbologyStore {
    return this.#store;
  }

  stats(): ResolverStats {
    return {
      ...this.#stats,
      openFigiCalls: this.#openFigi?.requestCount ?? 0,
      inProcessSize: this.#inProcess.size,
    };
  }

  /**
   * Adapters call this on every message, so it never touches the network or the database. A miss
   * returns UNRESOLVED_FIGI, which the CDM allows; prime() or resolve() fills it.
   */
  figiFor(symbol: string, provider?: ProviderId): string {
    return (
      this.#inProcess.get(this.#key(symbol, provider)) ??
      this.#inProcess.get(this.#key(symbol)) ??
      UNRESOLVED_FIGI
    );
  }

  /** A resolveFigi hook bound to one provider, to hand straight to an adapter's options. */
  hookFor(provider: ProviderId): (symbol: string) => string {
    return (symbol: string) => this.figiFor(symbol, provider);
  }

  async resolve(symbol: string, options: ResolveOptions = {}): Promise<Instrument | null> {
    const asOf = options.asOf ?? this.#now();
    const provider = options.provider;

    const cached = this.figiFor(symbol, provider);
    if (cached !== UNRESOLVED_FIGI && this.#isCurrent(asOf)) {
      this.#stats.cacheHits += 1;
      const instrument = await this.#store.getInstrument(cached);
      if (instrument) return instrument;
    }

    const stored = await this.#store.resolveSymbol({
      symbol,
      ...(provider ? { provider } : {}),
      asOf,
    });
    if (stored) {
      this.#stats.cacheHits += 1;
      this.#remember(symbol, stored.figi, provider);
      return stored;
    }
    this.#stats.cacheMisses += 1;

    // A historical query must not be answered by a service that only knows about today.
    if (!this.#isCurrent(asOf)) {
      this.#stats.historicalRefusals += 1;
      return null;
    }

    if (await this.#negativeHit(symbol, provider, options.assetClass)) return null;

    if (!this.#openFigi) {
      this.#stats.unresolved += 1;
      return null;
    }

    const [result] = await this.resolveMany([symbol], options);
    return result ?? null;
  }

  /**
   * Batches everything the store does not already know into as few OpenFIGI requests as the rate
   * limit allows. Returns results in input order.
   */
  async resolveMany(
    symbols: readonly string[],
    options: ResolveOptions = {},
  ): Promise<(Instrument | null)[]> {
    const asOf = options.asOf ?? this.#now();
    const provider = options.provider;
    const assetClass = options.assetClass ?? 'equity';
    const out = new Map<string, Instrument | null>();
    const toLookUp: string[] = [];

    for (const symbol of symbols) {
      if (options.force) {
        toLookUp.push(symbol);
        continue;
      }
      const stored = await this.#store.resolveSymbol({
        symbol,
        ...(provider ? { provider } : {}),
        asOf,
      });
      if (stored) {
        this.#stats.cacheHits += 1;
        this.#remember(symbol, stored.figi, provider);
        out.set(symbol, stored);
        continue;
      }
      this.#stats.cacheMisses += 1;
      if (!this.#isCurrent(asOf)) {
        this.#stats.historicalRefusals += 1;
        out.set(symbol, null);
        continue;
      }
      if (await this.#negativeHit(symbol, provider, options.assetClass)) {
        out.set(symbol, null);
        continue;
      }
      toLookUp.push(symbol);
    }

    if (toLookUp.length > 0 && this.#openFigi) {
      const jobs: OpenFigiJob[] = toLookUp.map((symbol) => ({
        symbol,
        assetClass,
        ...(options.exchCode ? { exchCode: options.exchCode } : {}),
        ...(options.currency ? { currency: options.currency } : {}),
      }));
      const results = await this.#openFigi.map(jobs);

      for (const result of results) {
        const symbol = result.job.symbol;
        if (result.kind === 'unmatched') {
          this.#stats.unresolved += 1;
          await this.#store.saveNegative({
            symbol: canonicalKey(symbol),
            provider,
            assetClass: options.assetClass,
            reason: result.reason,
            attempts: 1,
            expiresAt: new Date(this.#now().getTime() + this.#negativeTtlMs),
          });
          out.set(symbol, null);
          continue;
        }

        const match = pickMatch(result.matches, options.assetClass);
        if (!match || !isFigi(match.figi)) {
          this.#stats.unresolved += 1;
          out.set(symbol, null);
          continue;
        }

        const instrument = instrumentFrom(match, result.job, assetClass);
        await this.#store.save(instrument, this.#mappingsFor(instrument, symbol, asOf));
        this.#stats.resolved += 1;
        this.#remember(symbol, instrument.figi, provider);
        out.set(symbol, instrument);
      }
    } else if (toLookUp.length > 0) {
      for (const symbol of toLookUp) {
        this.#stats.unresolved += 1;
        out.set(symbol, null);
      }
    }

    return symbols.map((s) => out.get(s) ?? null);
  }

  /** Warms the in-process cache so adapters can stamp FIGIs from the first message onward. */
  async prime(symbols: readonly string[], options: ResolveOptions = {}): Promise<number> {
    const results = await this.resolveMany(symbols, options);
    return results.filter((r) => r !== null).length;
  }

  /**
   * Asks the vendor what this FIGI's ticker is today. The nightly refresh needs this: looking an
   * instrument up by its stored ticker cannot detect that the ticker moved, because the old ticker
   * either still resolves or resolves to somebody else.
   */
  async resolveByFigi(figi: string, assetClass: AssetClass = 'equity'): Promise<Instrument | null> {
    if (!this.#openFigi) return null;
    const [result] = await this.#openFigi.map([
      { symbol: figi, idType: 'ID_BB_GLOBAL', assetClass },
    ]);
    if (!result || result.kind === 'unmatched') return null;
    const match = pickMatch(result.matches, assetClass);
    if (!match || !isFigi(match.figi)) return null;
    return instrumentFrom(match, result.job, assetClass);
  }

  /** Records a symbol the vendor could not resolve, so a bad ticker costs one request, not many. */
  async rememberUnresolvable(
    symbol: string,
    reason: string,
    options: { readonly provider?: ProviderId; readonly assetClass?: AssetClass } = {},
  ): Promise<void> {
    await this.#store.saveNegative({
      symbol: canonicalKey(symbol),
      provider: options.provider,
      assetClass: options.assetClass,
      reason,
      attempts: 1,
      expiresAt: new Date(this.#now().getTime() + this.#negativeTtlMs),
    });
  }

  /** Opens a mapping window for a symbol that now points at this instrument. */
  async recordMapping(instrument: Instrument, symbol: string, validFrom: Date): Promise<void> {
    await this.#store.save(instrument, this.#mappingsFor(instrument, symbol, validFrom));
    this.#remember(symbol, instrument.figi);
  }

  async #negativeHit(
    symbol: string,
    provider: ProviderId | undefined,
    assetClass: AssetClass | undefined,
  ): Promise<boolean> {
    const negative = await this.#store.getNegative(symbol, provider, assetClass);
    if (!negative) return false;
    if (negative.expiresAt.getTime() <= this.#now().getTime()) {
      await this.#store.clearNegative(symbol, provider);
      return false;
    }
    this.#stats.negativeHits += 1;
    return true;
  }

  /**
   * Every provider's spelling of this symbol, so a quote from any of them resolves. The instrument
   * is the same; only the alias differs.
   */
  #mappingsFor(instrument: Instrument, symbol: string, validFrom: Date): SymbolMapping[] {
    const mappings: SymbolMapping[] = [];
    for (const provider of PROVIDER_IDS) {
      mappings.push({
        figi: instrument.figi,
        provider,
        symbol: toProviderSymbol(symbol, provider),
        validFrom,
        validTo: null,
      });
    }
    return mappings;
  }

  #isCurrent(asOf: Date): boolean {
    return this.#now().getTime() - asOf.getTime() <= this.#historicalCutoffMs;
  }

  #key(symbol: string, provider?: ProviderId): string {
    return provider ? `${provider}|${canonicalKey(symbol)}` : canonicalKey(symbol);
  }

  #remember(symbol: string, figi: string, provider?: ProviderId): void {
    this.#inProcess.set(this.#key(symbol), figi);
    if (provider) this.#inProcess.set(this.#key(symbol, provider), figi);
    for (const p of PROVIDER_IDS) {
      this.#inProcess.set(this.#key(toProviderSymbol(symbol, p), p), figi);
    }
  }
}
