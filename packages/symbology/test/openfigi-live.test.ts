import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFigi } from '@conduit/core';
import { toOpenFigiSymbol } from '../src/variants.js';

/**
 * Real answers from the live OpenFIGI v3 mapping API, captured unkeyed with `exchCode: 'US'`.
 *
 * OpenFIGI needs no API key for 25 requests a minute, so unlike the market data providers it could be
 * checked against reality — and doing so found a bug the synthetic 200-symbol fixture could never
 * have: without an exchange filter, `FB` resolved to FEDERAL BANK LTD in India, `SQ` to SAHAKOL
 * EQUIPMENT in Thailand, and `GOOGL` to an Argentine CEDEAR. Every one a plausible instrument that is
 * silently the wrong company.
 *
 * Refresh with scripts/capture-openfigi.mjs.
 */
interface LiveFixture {
  readonly capturedAt: string;
  readonly exchCode: string;
  readonly rows: {
    readonly symbol: string;
    readonly why: string;
    readonly figi: string | null;
    readonly ticker: string | null;
    readonly name: string | null;
  }[];
}

const live = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/openfigi-live.json'), 'utf8'),
) as LiveFixture;

const bySymbol = new Map(live.rows.map((r) => [r.symbol, r]));

describe('live OpenFIGI answers', () => {
  it('was captured with a US exchange filter', () => {
    expect(live.exchCode).toBe('US');
    expect(live.rows.length).toBeGreaterThanOrEqual(20);
  });

  it('returns well-formed FIGIs for everything it resolves', () => {
    for (const row of live.rows) {
      if (row.figi === null) continue;
      expect(isFigi(row.figi), `${row.symbol} -> ${row.figi}`).toBe(true);
    }
  });

  it('resolves US listings rather than foreign ones with the same ticker', () => {
    // The bug this filter fixes. GOOGL without it was an Argentine CEDEAR.
    expect(bySymbol.get('GOOGL')?.name).toMatch(/ALPHABET/);
    expect(bySymbol.get('GOOGL')?.figi).toBe('BBG009S39JX6');
    expect(bySymbol.get('AAPL')?.figi).toBe('BBG000B9XRY4');
    expect(bySymbol.get('MSFT')?.figi).toBe('BBG000BPH459');
  });

  it('resolves ETFs, which a securityType2 filter was silently breaking', () => {
    for (const symbol of ['SPY', 'QQQ', 'IWM', 'GLD']) {
      expect(bySymbol.get(symbol)?.figi, symbol).toBeTruthy();
    }
    expect(bySymbol.get('SPY')?.name).toMatch(/S&P 500/i);
  });

  it('distinguishes share classes of the same company', () => {
    const a = bySymbol.get('BRK.A')!;
    const b = bySymbol.get('BRK.B')!;
    expect(a.figi).not.toBe(b.figi);
    expect(a.name).toMatch(/CL A/);
    expect(b.name).toMatch(/CL B/);
    // And the class-share spelling conversion is what the service actually wanted.
    expect(toOpenFigiSymbol('BRK.B')).toBe('BRK/B');
    expect(b.ticker).toBe('BRK/B');
  });

  it('resolves both Alphabet classes to different instruments', () => {
    expect(bySymbol.get('GOOG')?.figi).not.toBe(bySymbol.get('GOOGL')?.figi);
    expect(bySymbol.get('GOOG')?.name).toMatch(/CL C/);
  });

  it('shows a freed ticker resolving to whoever holds it now', () => {
    // FB is no longer Meta. A current-date lookup correctly returns the ETF that took the ticker,
    // which is exactly why a historical query must come from the local security master instead.
    expect(bySymbol.get('FB')?.name).not.toMatch(/META/);
    expect(bySymbol.get('META')?.figi).toBe('BBG000MM2P62');
  });

  it('returns nothing for a delisted or unassigned ticker', () => {
    for (const symbol of ['TWTR', 'SQ', 'NOSUCHTICKERXYZ']) {
      expect(bySymbol.get(symbol)?.figi, symbol).toBeNull();
    }
  });
});
