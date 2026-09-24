import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  isClassShare,
  isDerivativeLike,
  parseSymbol,
  symbolVariants,
  toOpenFigiSymbol,
  toProviderSymbol,
} from '../src/variants.js';

describe('parseSymbol', () => {
  it('splits root from suffix whatever separator the vendor used', () => {
    for (const spelling of ['BRK.B', 'BRK B', 'BRK/B', 'BRK-B']) {
      expect(parseSymbol(spelling)).toEqual({ root: 'BRK', suffix: 'B' });
    }
  });

  it('leaves a plain ticker alone', () => {
    expect(parseSymbol('AAPL')).toEqual({ root: 'AAPL', suffix: '' });
  });

  it('uppercases and trims', () => {
    expect(parseSymbol('  brk.b ')).toEqual({ root: 'BRK', suffix: 'B' });
  });

  it('handles multi-character suffixes for preferreds and warrants', () => {
    expect(parseSymbol('WFC.PRL')).toEqual({ root: 'WFC', suffix: 'PRL' });
    expect(parseSymbol('DWAC.WS')).toEqual({ root: 'DWAC', suffix: 'WS' });
  });

  it('does not split a ticker that merely contains a digit', () => {
    expect(parseSymbol('BF1')).toEqual({ root: 'BF1', suffix: '' });
  });
});

describe('per-provider spelling', () => {
  it('converts BRK.B into each vendor convention', () => {
    expect(toProviderSymbol('BRK.B', 'polygon')).toBe('BRK.B');
    expect(toProviderSymbol('BRK.B', 'alpaca')).toBe('BRK.B');
    expect(toProviderSymbol('BRK.B', 'databento')).toBe('BRK B');
    expect(toProviderSymbol('BRK.B', 'tiingo')).toBe('BRK-B');
    expect(toOpenFigiSymbol('BRK.B')).toBe('BRK/B');
  });

  it('round-trips from any vendor spelling to any other', () => {
    for (const spelling of ['BRK.B', 'BRK B', 'BRK/B', 'BRK-B']) {
      expect(toProviderSymbol(spelling, 'databento')).toBe('BRK B');
      expect(toOpenFigiSymbol(spelling)).toBe('BRK/B');
    }
  });

  it('leaves plain tickers untouched in every convention', () => {
    for (const provider of ['polygon', 'alpaca', 'databento', 'tiingo'] as const) {
      expect(toProviderSymbol('AAPL', provider)).toBe('AAPL');
    }
  });
});

describe('classification', () => {
  it('separates a share class from an instrument type', () => {
    expect(isClassShare('BRK.B')).toBe(true);
    expect(isClassShare('AAPL')).toBe(false);
    expect(isClassShare('DWAC.WS')).toBe(false);
    expect(isDerivativeLike('DWAC.WS')).toBe(true);
    expect(isDerivativeLike('IPOF.U')).toBe(true);
    expect(isDerivativeLike('BRK.B')).toBe(false);
  });
});

describe('cache keys', () => {
  it('gives every spelling of one instrument the same key', () => {
    const keys = new Set(['BRK.B', 'BRK B', 'BRK/B', 'BRK-B'].map(canonicalKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('BRK/B');
  });

  it("lists every spelling, with the caller's own spelling first", () => {
    const variants = symbolVariants('BRK B');
    expect(variants[0]).toBe('BRK B');
    expect(new Set(variants)).toEqual(new Set(['BRK B', 'BRK.B', 'BRK/B', 'BRK-B']));
  });

  it('does not conflate two different instruments', () => {
    expect(canonicalKey('BRK.B')).not.toBe(canonicalKey('BRK.A'));
    expect(canonicalKey('BF.B')).not.toBe(canonicalKey('BRK.B'));
  });
});
