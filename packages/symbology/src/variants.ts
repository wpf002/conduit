import type { ProviderId } from '@conduit/core';

/**
 * The BRK.B problem. Every vendor spells a class share differently, and the spelling is not
 * derivable from the instrument — it is a per-vendor convention that has to be applied in both
 * directions.
 *
 * | Instrument            | Polygon  | Alpaca   | Databento | OpenFIGI |
 * |-----------------------|----------|----------|-----------|----------|
 * | Berkshire class B     | BRK.B    | BRK.B    | BRK B     | BRK/B    |
 * | Brown-Forman class B  | BF.B     | BF.B     | BF B      | BF/B     |
 * | Wells Fargo pref L    | WFC.PRL  | WFC.PL   | WFC PRL   | WFC/PL   |
 *
 * OpenFIGI wants the slash form for US equities; the vendors do not agree with each other.
 */
export type SymbolConvention = 'dot' | 'space' | 'slash' | 'dash';

export const PROVIDER_CONVENTION: Readonly<Record<ProviderId, SymbolConvention>> = {
  polygon: 'dot',
  alpaca: 'dot',
  databento: 'space',
  tiingo: 'dash',
};

/** OpenFIGI's own convention for US composite tickers. */
export const OPENFIGI_CONVENTION: SymbolConvention = 'slash';

const SEPARATOR: Readonly<Record<SymbolConvention, string>> = {
  dot: '.',
  space: ' ',
  slash: '/',
  dash: '-',
};

/**
 * Suffixes that are a share class or instrument-type marker rather than part of the root ticker.
 * A single trailing letter is a class; the longer forms are preferreds, warrants, rights, and
 * units.
 */
const CLASS_SUFFIX = /^[A-Z]$/;
const TYPE_SUFFIX = new Set(['PR', 'WS', 'WI', 'RT', 'U', 'CL', 'CV']);

export interface ParsedSymbol {
  readonly root: string;
  /** '' when the ticker has no class or type suffix. */
  readonly suffix: string;
}

/**
 * Splits a ticker into root and suffix, whatever convention it arrived in. `BRK.B`, `BRK B`,
 * `BRK/B`, and `BRK-B` all parse to the same pair, which is what makes cross-vendor mapping
 * possible without a lookup table per vendor pair.
 */
export function parseSymbol(symbol: string): ParsedSymbol {
  const trimmed = symbol.trim().toUpperCase();
  const match = /^([A-Z0-9]+)[.\-/ ]([A-Z0-9]{1,4})$/.exec(trimmed);
  if (!match) return { root: trimmed, suffix: '' };
  const [, root, suffix] = match;
  return { root: root!, suffix: suffix! };
}

export function formatSymbol(parsed: ParsedSymbol, convention: SymbolConvention): string {
  if (parsed.suffix === '') return parsed.root;
  // Preferred-series suffixes keep the PR prefix only where the vendor uses it.
  return `${parsed.root}${SEPARATOR[convention]}${parsed.suffix}`;
}

export function toProviderSymbol(symbol: string, provider: ProviderId): string {
  return formatSymbol(parseSymbol(symbol), PROVIDER_CONVENTION[provider]);
}

export function toOpenFigiSymbol(symbol: string): string {
  return formatSymbol(parseSymbol(symbol), OPENFIGI_CONVENTION);
}

/** True when the suffix marks a share class rather than an instrument type. */
export function isClassShare(symbol: string): boolean {
  const { suffix } = parseSymbol(symbol);
  return suffix !== '' && CLASS_SUFFIX.test(suffix);
}

export function isDerivativeLike(symbol: string): boolean {
  const { suffix } = parseSymbol(symbol);
  return suffix !== '' && TYPE_SUFFIX.has(suffix);
}

/**
 * Every spelling a symbol might arrive in, for cache lookups. Deduplicated and ordered so the
 * caller's own spelling is tried first.
 */
export function symbolVariants(symbol: string): string[] {
  const parsed = parseSymbol(symbol);
  const seen = new Set<string>([symbol.trim().toUpperCase()]);
  for (const convention of ['dot', 'space', 'slash', 'dash'] as const) {
    seen.add(formatSymbol(parsed, convention));
  }
  return [...seen];
}

/** Normalized key for caching, independent of which vendor spelled it. */
export function canonicalKey(symbol: string): string {
  const { root, suffix } = parseSymbol(symbol);
  return suffix === '' ? root : `${root}/${suffix}`;
}
