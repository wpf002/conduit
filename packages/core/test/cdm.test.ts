import { describe, expect, it } from 'vitest';
import { assertCdmInvariants, type Bar, type DepthSnapshot, type QuoteTick } from '../src/cdm.js';
import { SchemaError } from '../src/errors.js';
import { isFigi, UNRESOLVED_FIGI } from '../src/ids.js';

const quote: QuoteTick = {
  kind: 'quote',
  figi: 'BBG000B9XRY4',
  symbol: 'AAPL',
  provider: 'polygon',
  tsEvent: 1704205800123456789n,
  tsConduitRecv: 1704205800125000000n,
  bidPx: 185.1,
  bidSz: 300,
  askPx: 185.12,
  askSz: 200,
};

describe('assertCdmInvariants', () => {
  it('accepts a well-formed quote', () => {
    expect(() => assertCdmInvariants(quote)).not.toThrow();
  });

  it('accepts an unresolved FIGI but not a malformed one', () => {
    expect(() => assertCdmInvariants({ ...quote, figi: UNRESOLVED_FIGI })).not.toThrow();
    expect(() => assertCdmInvariants({ ...quote, figi: 'AAPL' })).toThrow(SchemaError);
  });

  it('rejects a crossed two-sided quote', () => {
    expect(() => assertCdmInvariants({ ...quote, bidPx: 185.2 })).toThrow(/crossed quote/);
  });

  it('allows a one-sided quote, which is normal at the open', () => {
    expect(() => assertCdmInvariants({ ...quote, bidPx: 0, bidSz: 0 })).not.toThrow();
  });

  it('rejects NaN prices rather than letting them reach a strategy', () => {
    expect(() => assertCdmInvariants({ ...quote, askPx: Number.NaN })).toThrow(/not finite/);
  });

  it('rejects non-positive timestamps', () => {
    expect(() => assertCdmInvariants({ ...quote, tsEvent: 0n })).toThrow(/tsEvent/);
    expect(() => assertCdmInvariants({ ...quote, tsConduitRecv: -1n })).toThrow(/tsConduitRecv/);
  });

  it('rejects an empty symbol', () => {
    expect(() => assertCdmInvariants({ ...quote, symbol: '' })).toThrow(/symbol is empty/);
  });

  const bar: Bar = {
    kind: 'bar',
    figi: UNRESOLVED_FIGI,
    symbol: 'AAPL',
    provider: 'alpaca',
    tsEvent: 1704205800000000000n,
    tsEventEnd: 1704205860000000000n,
    interval: '1m',
    open: 185,
    high: 185.5,
    low: 184.9,
    close: 185.2,
    volume: 12_000,
  };

  it('checks bar geometry', () => {
    expect(() => assertCdmInvariants(bar)).not.toThrow();
    expect(() => assertCdmInvariants({ ...bar, high: 184 })).toThrow(/below low/);
    expect(() => assertCdmInvariants({ ...bar, close: 999 })).toThrow(/outside high\/low/);
    expect(() => assertCdmInvariants({ ...bar, tsEventEnd: bar.tsEvent })).toThrow(/tsEventEnd/);
  });

  const depth: DepthSnapshot = {
    kind: 'depth',
    figi: UNRESOLVED_FIGI,
    symbol: 'ESZ4',
    provider: 'databento',
    tsEvent: 1704205800000000000n,
    tsConduitRecv: 1704205800000100000n,
    bids: [
      { px: 5000.25, sz: 10 },
      { px: 5000.0, sz: 22 },
    ],
    asks: [
      { px: 5000.5, sz: 8 },
      { px: 5000.75, sz: 14 },
    ],
  };

  it('enforces book ordering', () => {
    expect(() => assertCdmInvariants(depth)).not.toThrow();
    expect(() =>
      assertCdmInvariants({ ...depth, bids: [{ px: 1, sz: 1 }, { px: 2, sz: 1 }] }),
    ).toThrow(/bids not descending/);
    expect(() =>
      assertCdmInvariants({ ...depth, asks: [{ px: 2, sz: 1 }, { px: 1, sz: 1 }] }),
    ).toThrow(/asks not ascending/);
  });

  it('passes a control message through', () => {
    expect(() =>
      assertCdmInvariants({
        kind: 'control',
        control: 'provider_switch',
        provider: 'alpaca',
        previousProvider: 'polygon',
        reason: 'auth revoked',
        symbols: ['AAPL'],
        tsConduitRecv: 1n,
      }),
    ).not.toThrow();
  });
});

describe('isFigi', () => {
  it('accepts real FIGIs and rejects tickers and near-misses', () => {
    expect(isFigi('BBG000B9XRY4')).toBe(true);
    expect(isFigi('BBG000BPH459')).toBe(true);
    expect(isFigi('AAPL')).toBe(false);
    expect(isFigi('BBG000B9XRY')).toBe(false);
    // A and E are excluded from the FIGI alphabet to avoid look-alikes.
    expect(isFigi('BBG000A9XRY4')).toBe(false);
  });
});
