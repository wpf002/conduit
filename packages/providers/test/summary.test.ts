import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CdmFlags,
  CoverageError,
  assertCdmInvariants,
  hasFlag,
  isInstrumentSnapshot,
  nsToIso,
} from '@conduit/core';
import { alpaca } from '../src/alpaca/index.js';
import { databento } from '../src/databento/index.js';
import { tiingo } from '../src/tiingo/index.js';
import { normalizeAlpacaSnapshot } from '../src/alpaca/normalize.js';
import { normalizePolygonSnapshotSummary } from '../src/polygon/normalize.js';

/**
 * Shapes verified against the live Alpaca endpoint on 2026-09-27. Values are synthetic: real
 * captured market data is licensed and this repo is public, so only the structure is committed.
 */
const ALPACA_SNAPSHOT = {
  dailyBar: { c: 341.02, h: 341.67, l: 334.6, n: 18932, o: 335.955, t: '2026-09-25T04:00:00Z', v: 842202, vw: 338.613119 },
  // A closed market leaves the ask side empty, and the venue arrives as a single space.
  latestQuote: { ap: 0, as: 0, ax: ' ', bp: 319.05, bs: 40, bx: 'V', c: ['R'], t: '2026-09-25T20:00:02.178993693Z', z: 'C' },
  latestTrade: { c: ['@', 'F'], i: 18926, p: 341.02, s: 40, t: '2026-09-25T19:59:59.911684512Z', x: 'V', z: 'C' },
  minuteBar: { c: 341.02, h: 341.07, l: 340.925, n: 376, o: 340.94, t: '2026-09-25T19:59:00Z', v: 18247, vw: 341.011248 },
  prevDailyBar: { c: 335.88, h: 338.905, l: 334.33, n: 15976, o: 336.72, t: '2026-09-24T04:00:00Z', v: 788509, vw: 336.922831 },
  symbol: 'AAPL',
};

describe('alpaca summary normalization', () => {
  const snapshot = normalizeAlpacaSnapshot(ALPACA_SNAPSHOT, 'AAPL');

  it('carries everything a consumer needs for a price row', () => {
    expect(isInstrumentSnapshot(snapshot!)).toBe(true);
    expect(snapshot).toMatchObject({
      symbol: 'AAPL',
      lastPx: 341.02,
      lastSz: 40,
      bidPx: 319.05,
      askPx: 0,
      prevClose: 335.88,
    });
    expect(snapshot!.day).toEqual({
      open: 335.955,
      high: 341.67,
      low: 334.6,
      close: 341.02,
      volume: 842202,
      vwap: 338.613119,
      trades: 18932,
    });
  });

  it('leaves change to the consumer rather than inventing it', () => {
    // lastPx - prevClose is a subtraction. An adapter reporting it would be reporting a number the
    // venue never sent.
    expect(snapshot).not.toHaveProperty('change');
    expect(snapshot!.lastPx! - snapshot!.prevClose!).toBeCloseTo(5.14, 2);
  });

  it('takes the event time from the last trade, to the nanosecond', () => {
    expect(nsToIso(snapshot!.tsEvent)).toBe('2026-09-25T19:59:59.911684512Z');
  });

  it('marks it a snapshot and satisfies the CDM invariants with an empty ask side', () => {
    expect(hasFlag(snapshot!.flags, CdmFlags.Snapshot)).toBe(true);
    expect(() => assertCdmInvariants(snapshot!)).not.toThrow();
  });

  it('converts quote sizes by the same rule as the stream', () => {
    // bs 40 in round lots.
    expect(snapshot!.bidSz).toBe(4000);
    expect(normalizeAlpacaSnapshot(ALPACA_SNAPSHOT, 'AAPL', { quoteSizeUnits: 'shares' })!.bidSz).toBe(40);
  });

  it('survives a payload with no trade yet', () => {
    const noTrade = normalizeAlpacaSnapshot(
      { ...ALPACA_SNAPSHOT, latestTrade: undefined },
      'AAPL',
    );
    expect(noTrade!.lastPx).toBeUndefined();
    expect(nsToIso(noTrade!.tsEvent)).toBe('2026-09-25T20:00:02.178993693Z');
  });

  it('returns nothing for a payload with no timestamp anywhere', () => {
    expect(normalizeAlpacaSnapshot({ symbol: 'AAPL' }, 'AAPL')).toBeUndefined();
    expect(normalizeAlpacaSnapshot(null, 'AAPL')).toBeUndefined();
  });
});

describe('polygon summary normalization', () => {
  const POLYGON_SNAPSHOT = {
    ticker: 'AAPL',
    lastTrade: { p: 341.02, s: 40, t: 1790456399911684512, i: '1' },
    lastQuote: { p: 319.05, P: 0, s: 3, S: 0, t: 1790456402178993693 },
    day: { o: 335.955, h: 341.67, l: 334.6, c: 341.02, v: 842202, vw: 338.613119 },
    prevDay: { o: 336.72, h: 338.905, l: 334.33, c: 335.88, v: 788509 },
  };

  it('keeps the parts snapshot() was throwing away', () => {
    const summary = normalizePolygonSnapshotSummary(POLYGON_SNAPSHOT);
    expect(summary).toMatchObject({ lastPx: 341.02, bidPx: 319.05, prevClose: 335.88 });
    expect(summary!.day?.volume).toBe(842202);
    expect(() => assertCdmInvariants(summary!)).not.toThrow();
  });

  it('reports quote sizes in shares, as Massive has since 2025-11-03', () => {
    expect(normalizePolygonSnapshotSummary(POLYGON_SNAPSHOT)!.bidSz).toBe(3);
  });
});

// ------------------------------------------------------------------ over the wire
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('alpaca summary over HTTP', () => {
  it('asks /v2/stocks/snapshots for every symbol in one request', async () => {
    const paths: string[] = [];
    server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ AAPL: ALPACA_SNAPSHOT, MSFT: { ...ALPACA_SNAPSHOT, symbol: 'MSFT' } }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const adapter = alpaca({
      keyId: 'summary-test-key-id',
      secret: 'summary-test-secret',
      restBaseUrl: `http://127.0.0.1:${port}`,
    });
    const out = await adapter.summary({ symbols: ['AAPL', 'MSFT'] });
    expect(out.map((s) => s.symbol).sort()).toEqual(['AAPL', 'MSFT']);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('symbols=AAPL%2CMSFT');
    await adapter.close();
  });
});

describe('adapters without a snapshot endpoint', () => {
  it('throw CoverageError rather than returning an empty list', async () => {
    const db = databento({ apiKey: 'summary-test-key', dataset: 'XNAS.ITCH' });
    await expect(db.summary({ symbols: ['AAPL'] })).rejects.toThrow(CoverageError);
    const ti = tiingo({ apiKey: 'summary-test-key' });
    await expect(ti.summary({ symbols: ['AAPL'] })).rejects.toThrow(/no snapshot endpoint/);
  });
});
