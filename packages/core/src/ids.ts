export type ProviderId = 'polygon' | 'alpaca' | 'databento' | 'tiingo';

export const PROVIDER_IDS: readonly ProviderId[] = ['polygon', 'alpaca', 'databento', 'tiingo'];

export type AssetClass = 'equity' | 'etf' | 'option' | 'future' | 'crypto' | 'fx' | 'index';

export type Schema = 'quote_l1' | 'trades' | 'bars_1m' | 'bars_1d' | 'depth_10';

export const SCHEMAS: readonly Schema[] = ['quote_l1', 'trades', 'bars_1m', 'bars_1d', 'depth_10'];

export type BarInterval = '1m' | '1d';

/** '' until @conduit/symbology resolves the instrument. A CDM message is still valid without it. */
export const UNRESOLVED_FIGI = '';

/** OpenFIGI IDs are 12 characters, 'BBG' + 8 alphanumerics + check digit. */
export function isFigi(value: string): boolean {
  return /^BBG[0-9BCDFGHJKLMNPQRSTVWXYZ]{8}[0-9]$/.test(value);
}

export function schemaInterval(schema: Schema): BarInterval | undefined {
  if (schema === 'bars_1m') return '1m';
  if (schema === 'bars_1d') return '1d';
  return undefined;
}
