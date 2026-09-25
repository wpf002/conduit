import {
  SchemaError,
  UNRESOLVED_FIGI,
  isoToNs,
  nowNs,
  NS_PER_MS,
  type Bar,
  type MarketMessage,
} from '@conduit/core';

const PROVIDER = 'tiingo' as const;
const DAY_NS = 86_400_000n * NS_PER_MS;

/**
 * Tiingo returns both raw and split/dividend-adjusted prices for every daily bar. Which one belongs
 * in the CDM is a genuine choice, not a detail:
 *
 * - `'raw'` is what printed on the day. Two bars from different dates are not comparable across a
 *   split.
 * - `'adjusted'` is comparable across corporate actions, which is what a backtest almost always
 *   wants, but it is a derived value that changes retroactively when a split happens.
 *
 * The default is `'raw'`, because the CDM's contract is what the venue reported. The other set is
 * always present in `raw`, alongside `divCash` and `splitFactor`.
 */
export type TiingoPriceField = 'raw' | 'adjusted';

export interface TiingoNormalizeOptions {
  readonly resolveFigi?: (symbol: string) => string;
  readonly priceField?: TiingoPriceField;
  readonly includeRaw?: boolean;
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SchemaError(`expected a finite number at ${field}, got ${String(value)}`, {
      provider: PROVIDER,
      field,
    });
  }
  return value;
}

/** Tiingo dates are ISO-8601; some endpoints return a bare date with no time part. */
function ts(value: unknown): bigint {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SchemaError(`expected a date string at date, got ${String(value)}`, {
      provider: PROVIDER,
      field: 'date',
    });
  }
  const iso = value.includes('T') ? value : `${value}T00:00:00Z`;
  try {
    return isoToNs(iso);
  } catch (error) {
    throw new SchemaError(`cannot read date as ISO-8601: ${value}`, {
      provider: PROVIDER,
      field: 'date',
      cause: error,
    });
  }
}

/**
 * One Tiingo end-of-day record to a CDM daily bar. The symbol is not in the payload — the endpoint is
 * per-ticker — so the caller supplies it.
 */
export function normalizeTiingoBar(
  payload: unknown,
  symbol: string,
  options: TiingoNormalizeOptions = {},
): MarketMessage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  if (record['date'] === undefined) return undefined;

  const adjusted = (options.priceField ?? 'raw') === 'adjusted';
  const key = (base: 'Open' | 'High' | 'Low' | 'Close' | 'Volume'): string =>
    adjusted ? `adj${base}` : base.toLowerCase();

  const start = ts(record['date']);
  const bar: Bar = {
    kind: 'bar',
    figi: (options.resolveFigi ?? (() => UNRESOLVED_FIGI))(symbol),
    symbol,
    provider: PROVIDER,
    tsEvent: start,
    tsEventEnd: start + DAY_NS,
    tsConduitRecv: nowNs(),
    interval: '1d',
    open: num(record[key('Open')], key('Open')),
    high: num(record[key('High')], key('High')),
    low: num(record[key('Low')], key('Low')),
    close: num(record[key('Close')], key('Close')),
    volume: num(record[key('Volume')], key('Volume')),
    ...(options.includeRaw === false ? {} : { raw: payload }),
  };
  return bar;
}
