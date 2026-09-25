import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CdmFlags,
  SchemaError,
  UNRESOLVED_FIGI,
  assertCdmInvariants,
  hasFlag,
  isBar,
  isQuote,
  isTrade,
  nsToIso,
  type MarketMessage,
} from '@conduit/core';
import { normalizePolygonMessage, normalizePolygonSnapshot } from '../src/polygon/normalize.js';
import { parseJsonLossless, quoteLongIntegers } from '../src/json.js';
import { clearConditionFlags, registerConditionFlags } from '../src/conditions.js';

function loadFixture(name: string): unknown[] {
  const text = readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

const payloads = loadFixture('polygon-stocks.ndjson');

// The condition registry is module state; each test states its own mappings.
afterEach(clearConditionFlags);

describe('polygon fixture replay', () => {
  const normalized = payloads
    .map((p) => normalizePolygonMessage(p))
    .filter((m): m is MarketMessage => m !== undefined);

  it('emits only the message types Conduit exposes', () => {
    // 11 fixture lines: 2 status, 3 Q, 3 T, 2 AM, 1 second-aggregate A that is not exposed.
    expect(normalized).toHaveLength(8);
    expect(normalized.filter(isQuote)).toHaveLength(3);
    expect(normalized.filter(isTrade)).toHaveLength(3);
    expect(normalized.filter(isBar)).toHaveLength(2);
  });

  it('satisfies every CDM invariant', () => {
    for (const message of normalized) {
      expect(() => assertCdmInvariants(message)).not.toThrow();
    }
  });

  it('carries both timestamps on every message, ingress after venue', () => {
    for (const message of normalized) {
      expect(typeof message.tsEvent).toBe('bigint');
      expect(typeof message.tsConduitRecv).toBe('bigint');
      expect(message.tsConduitRecv).toBeGreaterThan(message.tsEvent);
    }
  });

  it('leaves figi unresolved until symbology runs', () => {
    expect(normalized.every((m) => m.figi === UNRESOLVED_FIGI)).toBe(true);
  });

  it('resolves figi through the injected hook when one is given', () => {
    const [quote] = payloads
      .map((p) => normalizePolygonMessage(p, { resolveFigi: () => 'BBG000B9XRY4' }))
      .filter((m): m is MarketMessage => m !== undefined);
    expect(quote!.figi).toBe('BBG000B9XRY4');
  });
});

describe('polygon quote normalization', () => {
  const quote = normalizePolygonMessage(payloads[2]);

  it('converts the millisecond SIP timestamp to nanoseconds without inventing precision', () => {
    expect(quote!.tsEvent).toBe(1704205800123000000n);
    expect(nsToIso(quote!.tsEvent)).toBe('2024-01-02T14:30:00.123000000Z');
  });

  it('reports quote sizes in shares, which is what Massive has sent since 2025-11-03', () => {
    // bs:3 means three shares, not three round lots. Multiplying by 100 here would overstate
    // every quote size by 100x, which looks plausible in a log and shows up as bad fills.
    expect(isQuote(quote!) && quote!.bidSz).toBe(3);
    expect(isQuote(quote!) && quote!.askSz).toBe(2);
  });

  it('multiplies by the round lot only when replaying pre-cutover flat files', () => {
    const lots = normalizePolygonMessage(payloads[2], { quoteSizeUnits: 'lots' });
    expect(isQuote(lots!) && lots!.bidSz).toBe(300);
    expect(isQuote(lots!) && lots!.askSz).toBe(200);
  });

  it("carries the vendor's own venue code verbatim rather than guessing at a MIC", () => {
    // Massive's numeric ids are only documented behind an authenticated reference endpoint, so a
    // hand-written MIC table would be invention. An earlier one had id 62 wrong.
    expect(isQuote(quote!) && quote!.bidVenue).toBe('11');
    expect(isQuote(quote!) && quote!.askVenue).toBe('12');
  });

  it('keeps the sequence number Polygon provides', () => {
    expect(quote!.seq).toBe(13684490n);
  });

  it('accepts a one-sided quote at the open', () => {
    const oneSided = normalizePolygonMessage(payloads[4]);
    expect(isQuote(oneSided!) && oneSided!.bidPx).toBe(0);
    expect(() => assertCdmInvariants(oneSided!)).not.toThrow();
  });

  it('keeps the raw payload for the fields that cannot be normalized', () => {
    expect(quote!.raw).toBe(payloads[2]);
    expect(normalizePolygonMessage(payloads[2], { includeRaw: false })!.raw).toBeUndefined();
  });
});

describe('polygon trade normalization', () => {
  it('maps no condition code until a table is registered', () => {
    // Massive's numeric conditions table is only available from /v3/reference/conditions, so the
    // adapter ships no mappings rather than guessed ones.
    const extendedHours = normalizePolygonMessage(payloads[6]);
    expect(hasFlag(extendedHours!.flags, CdmFlags.TradeThroughExempt)).toBe(false);
  });

  it('maps condition codes once a registered table covers them', () => {
    registerConditionFlags('polygon', { 12: CdmFlags.TradeThroughExempt, 37: CdmFlags.OddLot });
    const oddLot = normalizePolygonMessage(payloads[5]);
    expect(hasFlag(oddLot!.flags, CdmFlags.OddLot)).toBe(true);
    // Reported by the venue via condition 37, so not marked Derived.
    expect(hasFlag(oddLot!.flags, CdmFlags.Derived)).toBe(false);

    const extendedHours = normalizePolygonMessage(payloads[6]);
    expect(hasFlag(extendedHours!.flags, CdmFlags.TradeThroughExempt)).toBe(true);
  });

  it('derives odd-lot from size when no condition code says so, and marks it Derived', () => {
    const derived = normalizePolygonMessage({
      ev: 'T',
      sym: 'AAPL',
      i: '1',
      x: 11,
      p: 185,
      s: 7,
      c: [],
      t: 1704205800124,
      q: 1,
    });
    expect(hasFlag(derived!.flags, CdmFlags.OddLot)).toBe(true);
    expect(hasFlag(derived!.flags, CdmFlags.Derived)).toBe(true);
  });

  it('sets no flags on an ordinary round-lot trade', () => {
    const plain = normalizePolygonMessage(payloads[7]);
    expect(plain!.flags).toBe(0);
  });

  it('prefers ds over s so a fractional-share trade is not truncated', () => {
    const fractional = normalizePolygonMessage({
      ev: 'T',
      sym: 'AAPL',
      i: '1',
      x: 11,
      p: 185,
      s: 0,
      ds: '0.25',
      c: [],
      t: 1704205800124,
      q: 1,
    });
    expect(isTrade(fractional!) && fractional!.sz).toBe(0.25);
  });

  it('keeps trade sizes in shares', () => {
    const trade = normalizePolygonMessage(payloads[7]);
    expect(isTrade(trade!) && trade!.sz).toBe(200);
    expect(isTrade(trade!) && trade!.venue).toBe('62');
    expect(isTrade(trade!) && trade!.tradeId).toBe('52983525029463');
  });
});

describe('polygon bar normalization', () => {
  const bar = normalizePolygonMessage(payloads[8]);

  it('uses the aggregate window for both timestamps', () => {
    expect(bar!.tsEvent).toBe(1704205800000000000n);
    expect(isBar(bar!) && bar!.tsEventEnd).toBe(1704205860000000000n);
    expect(isBar(bar!) && bar!.interval).toBe('1m');
  });

  it('carries vwap and drops the fields with no cross-vendor equivalent', () => {
    expect(isBar(bar!) && bar!.vwap).toBe(185.05);
    // av and op exist only on Polygon; they stay in raw rather than in the CDM.
    expect(bar).not.toHaveProperty('accumulatedVolume');
  });

  it('defaults the window end when Polygon omits it', () => {
    const noEnd = normalizePolygonMessage({
      ev: 'AM',
      sym: 'AAPL',
      v: 1,
      o: 1,
      c: 1,
      h: 1,
      l: 1,
      s: 1704205800000,
    });
    expect(isBar(noEnd!) && noEnd!.tsEventEnd).toBe(1704205860000000000n);
  });
});

describe('malformed payloads', () => {
  it('throws SchemaError rather than emitting NaN', () => {
    expect(() =>
      normalizePolygonMessage({ ev: 'Q', sym: 'AAPL', bp: 'oops', bs: 1, ap: 2, as: 1, t: 1 }),
    ).toThrow(SchemaError);
    expect(() => normalizePolygonMessage({ ev: 'T', sym: '', p: 1, s: 1, t: 1 })).toThrow(
      SchemaError,
    );
  });

  it('ignores frames that carry no market data', () => {
    expect(normalizePolygonMessage(payloads[0])).toBeUndefined();
    expect(normalizePolygonMessage(null)).toBeUndefined();
    expect(normalizePolygonMessage({ ev: 42 })).toBeUndefined();
    expect(normalizePolygonMessage({ no: 'ev' })).toBeUndefined();
  });
});

describe('snapshot normalization', () => {
  // The body as Polygon sends it. A TypeScript number literal would already be truncated, so the
  // fixture has to stay text all the way to the parser.
  const SNAPSHOT_BODY =
    '{"tickers":[{"ticker":"AAPL","lastQuote":{"P":185.12,"S":2,"p":185.1,"s":3,"t":1704205800123456789}}]}';

  it('reads the nanosecond timestamp the REST endpoint returns for the same field name', () => {
    const body = parseJsonLossless(SNAPSHOT_BODY) as { tickers: unknown[] };
    const quote = normalizePolygonSnapshot(body.tickers[0]);
    expect(quote!.tsEvent).toBe(1704205800123456789n);
    expect(quote!.bidSz).toBe(3);
    expect(hasFlag(quote!.flags, CdmFlags.Snapshot)).toBe(true);
  });

  it('would lose the last three digits through a plain JSON.parse', () => {
    // Documents why parseJsonLossless exists: this is the bug it prevents, not a hypothetical.
    const naive = JSON.parse(SNAPSHOT_BODY) as { tickers: { lastQuote: { t: number } }[] };
    expect(BigInt(naive.tickers[0]!.lastQuote.t)).toBe(1704205800123456768n);
  });

  it('skips entries with no last quote', () => {
    expect(normalizePolygonSnapshot({ ticker: 'AAPL' })).toBeUndefined();
    expect(normalizePolygonSnapshot(null)).toBeUndefined();
  });
});
