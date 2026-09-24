import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNRESOLVED_FIGI, isFigi, type AssetClass, type Instrument } from '@conduit/core';
import { MemorySymbologyStore, type SymbolMapping } from '../src/store.js';
import { SymbologyResolver } from '../src/resolver.js';
import { refreshSecurityMaster } from '../src/refresh.js';
import type { OpenFigiJob, OpenFigiResult } from '../src/openfigi.js';
import { toOpenFigiSymbol } from '../src/variants.js';

interface Fixture {
  readonly instrumentCount: number;
  readonly queryCount: number;
  readonly instruments: {
    figi: string;
    ticker: string;
    name: string;
    assetClass: AssetClass;
    exchangeMic: string;
    currency: string;
    active: boolean;
    mappings: { symbol: string; validFrom: string; validTo: string | null }[];
  }[];
  readonly queries: {
    symbol: string;
    provider: 'polygon' | 'alpaca' | 'databento' | 'tiingo';
    asOf: string;
    expectFigi: string | null;
    why: string;
  }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/security-master.json'), 'utf8'),
) as Fixture;

/** Loads the fixture into a store the way a completed nightly refresh would have left it. */
async function loadedStore(): Promise<MemorySymbologyStore> {
  const store = new MemorySymbologyStore();
  for (const entry of fixture.instruments) {
    const instrument: Instrument = {
      figi: entry.figi,
      ticker: entry.ticker,
      name: entry.name,
      assetClass: entry.assetClass,
      exchangeMic: entry.exchangeMic,
      currency: entry.currency,
      active: entry.active,
    };
    const mappings: SymbolMapping[] = [];
    for (const mapping of entry.mappings) {
      for (const provider of ['polygon', 'alpaca', 'databento', 'tiingo']) {
        mappings.push({
          figi: entry.figi,
          provider,
          symbol: mapping.symbol,
          validFrom: new Date(mapping.validFrom),
          validTo: mapping.validTo === null ? null : new Date(mapping.validTo),
        });
      }
    }
    await store.save(instrument, mappings);
  }
  return store;
}

/** A stand-in for OpenFIGI that answers from a table, so no network is involved. */
class FakeOpenFigi {
  requestCount = 0;
  readonly batchSize = 100;
  readonly rateLimit = 250;
  #table: Map<string, string>;
  #calls: string[][] = [];

  constructor(table: Record<string, string> = {}) {
    this.#table = new Map(Object.entries(table));
  }

  get calls(): readonly string[][] {
    return this.#calls;
  }

  set(symbol: string, figi: string): void {
    this.#table.set(toOpenFigiSymbol(symbol), figi);
  }

  delete(symbol: string): void {
    this.#table.delete(toOpenFigiSymbol(symbol));
  }

  async map(jobs: readonly OpenFigiJob[]): Promise<OpenFigiResult[]> {
    this.requestCount += 1;
    this.#calls.push(jobs.map((j) => j.symbol));
    return jobs.map((job) => {
      // A FIGI lookup answers with whatever ticker currently maps to that FIGI, which is how a
      // rename becomes visible.
      if (job.idType === 'ID_BB_GLOBAL') {
        const ticker = [...this.#table.entries()].find(([, figi]) => figi === job.symbol)?.[0];
        if (!ticker) return { kind: 'unmatched' as const, job, reason: 'No identifier found.' };
        return {
          kind: 'matched' as const,
          job,
          matches: [
            { figi: job.symbol, compositeFIGI: job.symbol, ticker, name: `${ticker} Inc` },
          ],
        };
      }
      const figi = this.#table.get(toOpenFigiSymbol(job.symbol));
      if (!figi) return { kind: 'unmatched' as const, job, reason: 'No identifier found.' };
      return {
        kind: 'matched' as const,
        job,
        matches: [
          {
            figi,
            compositeFIGI: figi,
            ticker: job.symbol,
            name: `${job.symbol} Inc`,
            securityType: job.assetClass === 'etf' ? 'ETP' : 'Common Stock',
          },
        ],
      };
    });
  }
}

function resolverWith(
  store: MemorySymbologyStore,
  openFigi?: FakeOpenFigi,
  now = () => new Date('2026-09-24T00:00:00.000Z'),
): SymbologyResolver {
  return new SymbologyResolver({
    store,
    ...(openFigi ? { openFigi: openFigi as unknown as never } : {}),
    now,
  });
}

// --------------------------------------------------------------- acceptance test
describe('phase 3 acceptance: 200-symbol resolution', () => {
  it('has a fixture covering every hard case the roadmap names', () => {
    expect(fixture.queryCount).toBe(200);
    const reasons = new Set(fixture.queries.map((q) => q.why));
    expect([...reasons].some((r) => r.startsWith('class share'))).toBe(true);
    expect([...reasons].some((r) => r.includes('rename'))).toBe(true);
    expect([...reasons].some((r) => r.includes('delisted'))).toBe(true);
    expect([...reasons].some((r) => r.includes('reused'))).toBe(true);
    expect(fixture.instruments.every((i) => isFigi(i.figi))).toBe(true);
  });

  it('resolves at least 99% of the 200 queries correctly', async () => {
    const resolver = resolverWith(await loadedStore());
    const misses: string[] = [];

    for (const query of fixture.queries) {
      const instrument = await resolver.resolve(query.symbol, {
        provider: query.provider,
        asOf: new Date(query.asOf),
      });
      const got = instrument?.figi ?? null;
      if (got !== query.expectFigi) {
        misses.push(
          `${query.symbol} @${query.asOf} (${query.why}): expected ${query.expectFigi}, got ${got}`,
        );
      }
    }

    const accuracy = (fixture.queries.length - misses.length) / fixture.queries.length;
    expect(misses).toEqual([]);
    expect(accuracy).toBeGreaterThanOrEqual(0.99);
  });

  it('resolves every vendor spelling of a class share to one instrument', async () => {
    const resolver = resolverWith(await loadedStore());
    const asOf = new Date('2024-06-03T00:00:00.000Z');
    const figis = new Set<string | null>();
    for (const [symbol, provider] of [
      ['BRK.B', 'polygon'],
      ['BRK.B', 'alpaca'],
      ['BRK B', 'databento'],
      ['BRK-B', 'tiingo'],
      ['BRK/B', 'polygon'],
    ] as const) {
      const instrument = await resolver.resolve(symbol, { provider, asOf });
      figis.add(instrument?.figi ?? null);
    }
    expect(figis.size).toBe(1);
    expect([...figis][0]).not.toBeNull();
  });
});

// ------------------------------------------------------------- temporal queries
describe('temporal resolution', () => {
  it('resolves a reused ticker to the tenant that held it on the query date', async () => {
    const resolver = resolverWith(await loadedStore());
    const old = await resolver.resolve('CBRE', { asOf: new Date('1999-03-01T00:00:00.000Z') });
    const current = await resolver.resolve('CBRE', { asOf: new Date('2024-06-03T00:00:00.000Z') });
    expect(old).not.toBeNull();
    expect(current).not.toBeNull();
    // Same string, two companies. This is the case that silently corrupts a backtest.
    expect(old!.figi).not.toBe(current!.figi);
  });

  it('returns nothing for a date in the gap between two tenants', async () => {
    const resolver = resolverWith(await loadedStore());
    expect(await resolver.resolve('CBRE', { asOf: new Date('2003-01-02T00:00:00.000Z') })).toBeNull();
  });

  it('keeps the FIGI stable across a ticker change and moves only the mapping', async () => {
    const resolver = resolverWith(await loadedStore());
    const beforeRename = await resolver.resolve('FB', {
      asOf: new Date('2019-01-02T00:00:00.000Z'),
    });
    const afterRename = await resolver.resolve('META', {
      asOf: new Date('2024-06-03T00:00:00.000Z'),
    });
    expect(beforeRename!.figi).toBe(afterRename!.figi);
  });

  it('refuses to answer a post-rename spelling for a date before the rename', async () => {
    const resolver = resolverWith(await loadedStore());
    expect(
      await resolver.resolve('META', { asOf: new Date('2021-06-01T00:00:00.000Z') }),
    ).toBeNull();
  });

  it('resolves a delisted ticker inside its window and not after it', async () => {
    const resolver = resolverWith(await loadedStore());
    expect(
      await resolver.resolve('TWTR', { asOf: new Date('2021-06-01T00:00:00.000Z') }),
    ).not.toBeNull();
    expect(
      await resolver.resolve('TWTR', { asOf: new Date('2024-06-03T00:00:00.000Z') }),
    ).toBeNull();
  });

  it('never asks OpenFIGI about a historical date, because it only knows about today', async () => {
    const openFigi = new FakeOpenFigi({ 'NEWCO': 'BBG00NWCX001' });
    const resolver = resolverWith(new MemorySymbologyStore(), openFigi);

    // A current-date miss goes to OpenFIGI.
    expect(await resolver.resolve('NEWCO')).not.toBeNull();
    expect(openFigi.requestCount).toBe(1);

    // A historical miss does not: answering it from today's data is the corruption.
    expect(
      await resolver.resolve('SOMETHINGELSE', { asOf: new Date('2015-01-02T00:00:00.000Z') }),
    ).toBeNull();
    expect(openFigi.requestCount).toBe(1);
    expect(resolver.stats().historicalRefusals).toBe(1);
  });
});

// ------------------------------------------------------------------ live lookups
describe('resolution against OpenFIGI', () => {
  it('writes through to the store and to the in-process cache', async () => {
    const store = new MemorySymbologyStore();
    const openFigi = new FakeOpenFigi({ NEWCO: 'BBG00NWCX001' });
    const resolver = resolverWith(store, openFigi);

    const first = await resolver.resolve('NEWCO');
    expect(first!.figi).toBe('BBG00NWCX001');
    expect(resolver.figiFor('NEWCO')).toBe('BBG00NWCX001');

    // Second call is served from cache.
    await resolver.resolve('NEWCO');
    expect(openFigi.requestCount).toBe(1);
    expect(store.size).toBe(1);
  });

  it('stores a mapping per provider, in that provider spelling', async () => {
    const store = new MemorySymbologyStore();
    const openFigi = new FakeOpenFigi({ 'NEW/B': 'BBG00NWBX001' });
    const resolver = resolverWith(store, openFigi);
    await resolver.resolve('NEW.B');

    const mappings = await store.mappingsFor('BBG00NWBX001');
    const byProvider = Object.fromEntries(mappings.map((m) => [m.provider, m.symbol]));
    expect(byProvider).toEqual({
      polygon: 'NEW.B',
      alpaca: 'NEW.B',
      databento: 'NEW B',
      tiingo: 'NEW-B',
    });
  });

  it('gives adapters a synchronous hook that answers from cache only', async () => {
    const openFigi = new FakeOpenFigi({ AAPL: 'BBG000B9XRY4' });
    const resolver = resolverWith(new MemorySymbologyStore(), openFigi);
    const hook = resolver.hookFor('databento');

    expect(hook('AAPL')).toBe(UNRESOLVED_FIGI);
    await resolver.prime(['AAPL']);
    expect(hook('AAPL')).toBe('BBG000B9XRY4');
    // Databento would spell it differently; the hook still answers.
    expect(resolver.hookFor('databento')('AAPL')).toBe('BBG000B9XRY4');
  });

  it('batches a cache-miss set into one request', async () => {
    const openFigi = new FakeOpenFigi({ AAA: 'BBG00TST1001', BBB: 'BBG00TST2001' });
    const resolver = resolverWith(new MemorySymbologyStore(), openFigi);
    await resolver.resolveMany(['AAA', 'BBB', 'CCC']);
    expect(openFigi.calls).toEqual([['AAA', 'BBB', 'CCC']]);
  });

  it('returns results in input order even when some are misses', async () => {
    const openFigi = new FakeOpenFigi({ AAA: 'BBG00TST1001' });
    const resolver = resolverWith(new MemorySymbologyStore(), openFigi);
    const results = await resolver.resolveMany(['ZZZ', 'AAA']);
    expect(results[0]).toBeNull();
    expect(results[1]!.figi).toBe('BBG00TST1001');
  });

  it('resolves nothing beyond the cache when no OpenFIGI client is configured', async () => {
    const resolver = resolverWith(await loadedStore());
    expect(await resolver.resolve('AAPL')).not.toBeNull();
    expect(await resolver.resolve('NOTINFIXTURE')).toBeNull();
  });
});

// --------------------------------------------------------------- negative cache
describe('negative caching', () => {
  it('stops asking about an unresolvable symbol', async () => {
    const openFigi = new FakeOpenFigi();
    const resolver = resolverWith(new MemorySymbologyStore(), openFigi);

    expect(await resolver.resolve('GARBAGE')).toBeNull();
    expect(await resolver.resolve('GARBAGE')).toBeNull();
    expect(await resolver.resolve('GARBAGE')).toBeNull();
    expect(openFigi.requestCount).toBe(1);
    expect(resolver.stats().negativeHits).toBe(2);
  });

  it('treats every spelling of the same symbol as one negative entry', async () => {
    const openFigi = new FakeOpenFigi();
    const resolver = resolverWith(new MemorySymbologyStore(), openFigi);
    await resolver.resolve('GARBAGE.B');
    await resolver.resolve('GARBAGE B');
    await resolver.resolve('GARBAGE-B');
    expect(openFigi.requestCount).toBe(1);
  });

  it('expires the entry so a new listing is not stuck forever', async () => {
    let clock = new Date('2026-09-24T00:00:00.000Z');
    const openFigi = new FakeOpenFigi();
    const store = new MemorySymbologyStore();
    const resolver = new SymbologyResolver({
      store,
      openFigi: openFigi as unknown as never,
      negativeTtlMs: 1,
      now: () => clock,
    });

    expect(await resolver.resolve('IPOTOMORROW')).toBeNull();
    await new Promise((r) => setTimeout(r, 5));

    // The listing exists now.
    openFigi.set('IPOTOMORROW', 'BBG00NWLST01');
    clock = new Date(clock.getTime() + 1000);
    expect((await resolver.resolve('IPOTOMORROW'))?.figi).toBe('BBG00NWLST01');
  });
});

// -------------------------------------------------------------- nightly refresh
describe('nightly refresh', () => {
  it('closes the old mapping when a ticker moves instead of overwriting it', async () => {
    const store = new MemorySymbologyStore();
    const openFigi = new FakeOpenFigi({ OLDCO: 'BBG00RNMV001' });
    let clock = new Date('2026-09-24T00:00:00.000Z');
    const resolver = new SymbologyResolver({
      store,
      openFigi: openFigi as unknown as never,
      now: () => clock,
    });

    await resolver.resolve('OLDCO');
    const before = await store.mappingsFor('BBG00RNMV001');
    expect(before.every((m) => m.validTo === null)).toBe(true);

    // The company renames: same FIGI, new ticker.
    clock = new Date('2026-10-01T00:00:00.000Z');
    openFigi.delete('OLDCO');
    openFigi.set('NEWCO', 'BBG00RNMV001');
    const changes: string[] = [];
    const report = await refreshSecurityMaster(resolver, {
      maxAgeMs: 1,
      now: () => clock,
      onChange: (c) => changes.push(c.kind),
    });

    expect(report).toMatchObject({ examined: 1, tickerChanges: 1, delistings: 0 });
    expect(changes).toContain('ticker_changed');

    const after = await store.mappingsFor('BBG00RNMV001');
    expect(after.filter((m) => m.symbol === 'OLDCO').every((m) => m.validTo !== null)).toBe(true);
    expect(after.some((m) => m.symbol === 'NEWCO' && m.validTo === null)).toBe(true);

    // Both questions have the right answer: the old spelling inside its window, the new one after.
    expect(
      (await store.resolveSymbol({ symbol: 'OLDCO', asOf: new Date('2026-09-25T00:00:00.000Z') }))
        ?.figi,
    ).toBe('BBG00RNMV001');
    expect(
      (await store.resolveSymbol({ symbol: 'NEWCO', asOf: new Date('2026-10-02T00:00:00.000Z') }))
        ?.figi,
    ).toBe('BBG00RNMV001');
    // And the old spelling does not leak past its window.
    expect(
      await store.resolveSymbol({ symbol: 'OLDCO', asOf: new Date('2026-10-02T00:00:00.000Z') }),
    ).toBeNull();
  });

  it('marks an instrument inactive when it stops resolving', async () => {
    const store = new MemorySymbologyStore();
    const openFigi = new FakeOpenFigi({ GONECO: 'BBG00DLST001' });
    let clock = new Date('2026-09-24T00:00:00.000Z');
    const resolver = new SymbologyResolver({
      store,
      openFigi: openFigi as unknown as never,
      now: () => clock,
    });
    await resolver.resolve('GONECO');

    // Delisted: neither the ticker nor the FIGI resolves any more.
    openFigi.delete('GONECO');
    clock = new Date('2026-10-01T00:00:00.000Z');
    const changes: string[] = [];
    const report = await refreshSecurityMaster(resolver, {
      maxAgeMs: 1,
      now: () => clock,
      onChange: (c) => changes.push(c.kind),
    });

    expect(report.delistings).toBe(1);
    expect(changes).toContain('delisted');
    expect((await store.getInstrument('BBG00DLST001'))?.active).toBe(false);
    // The mapping is closed, not deleted: a query inside the old window still resolves.
    const historical = await store.resolveSymbol({
      symbol: 'GONECO',
      asOf: new Date('2026-09-25T00:00:00.000Z'),
    });
    expect(historical?.figi).toBe('BBG00DLST001');
  });

  it('leaves an unchanged instrument alone', async () => {
    const store = new MemorySymbologyStore();
    const openFigi = new FakeOpenFigi({ SAMECO: 'BBG00SMCX001' });
    let clock = new Date('2026-09-24T00:00:00.000Z');
    const resolver = new SymbologyResolver({
      store,
      openFigi: openFigi as unknown as never,
      now: () => clock,
    });
    await resolver.resolve('SAMECO');
    clock = new Date('2026-10-01T00:00:00.000Z');
    const report = await refreshSecurityMaster(resolver, { maxAgeMs: 1, now: () => clock });
    expect(report).toEqual({ examined: 1, tickerChanges: 0, delistings: 0, failures: 0 });
  });
});
