/**
 * Venue identity has no shared vocabulary across vendors (docs/cdm-draft.md row 5). Each adapter
 * maps its provider's code to a MIC where one exists, and leaves the field undefined otherwise
 * rather than inventing a value. The original code stays in `raw`.
 */
export const POLYGON_EXCHANGE_MIC: Readonly<Record<number, string>> = {
  1: 'XASE', // NYSE American
  2: 'XNAS', // Nasdaq OMX BX
  3: 'XNYS', // NYSE National
  4: 'FINR', // FINRA
  5: 'XNAS',
  6: 'XNAS', // Nasdaq ISE
  7: 'ARCX', // NYSE Arca
  8: 'XNAS',
  9: 'XNYS',
  10: 'XNYS', // NYSE American options
  11: 'XBOS', // Nasdaq BX
  12: 'XNYS',
  13: 'XCIS', // NYSE Chicago
  14: 'XCHI',
  15: 'IEXG', // IEX
  16: 'XNAS',
  17: 'XNAS',
  18: 'XNAS',
  19: 'EDGA',
  20: 'EDGX',
  21: 'BATY',
  22: 'BATS',
  23: 'XNAS',
  62: 'MEMX',
  63: 'LTSE',
};

/** Alpaca reports a single-character CTA/UTP exchange code. */
export const ALPACA_EXCHANGE_MIC: Readonly<Record<string, string>> = {
  A: 'XASE',
  B: 'XBOS',
  C: 'XCIS',
  D: 'FINR',
  H: 'MIHI',
  I: 'IEXG',
  J: 'EDGA',
  K: 'EDGX',
  L: 'LTSE',
  M: 'XCHI',
  N: 'XNYS',
  P: 'ARCX',
  Q: 'XNAS',
  S: 'FINR',
  T: 'XNAS',
  U: 'OOTC',
  V: 'IEXG',
  W: 'XCBO',
  X: 'XPHL',
  Y: 'BATY',
  Z: 'BATS',
};

export function polygonMic(code: unknown): string | undefined {
  return typeof code === 'number' ? POLYGON_EXCHANGE_MIC[code] : undefined;
}

export function alpacaMic(code: unknown): string | undefined {
  return typeof code === 'string' ? ALPACA_EXCHANGE_MIC[code.toUpperCase()] : undefined;
}
