import {
  CdmFlags,
  SchemaError,
  UNRESOLVED_FIGI,
  nowNs,
  NS_PER_MS,
  type Bar,
  type BarInterval,
  type DepthLevel,
  type DepthSnapshot,
  type MarketMessage,
  type QuoteTick,
  type Schema,
  type TradeTick,
} from '@conduit/core';
import { coerceEpochNs } from '../epoch.js';

const PROVIDER = 'databento' as const;

/** Databento prices are int64 fixed-point with a 1e-9 scale. */
const PRICE_SCALE = 1_000_000_000;

/** int64 max marks an absent price — an empty book side, not a real level. */
const UNDEF_PRICE = 9_223_372_036_854_775_807n;

/** Databento record flags. Only SNAPSHOT has a Conduit-level equivalent. */
export const DBN_FLAG_LAST = 1 << 7;
export const DBN_FLAG_TOB = 1 << 6;
export const DBN_FLAG_SNAPSHOT = 1 << 5;
export const DBN_FLAG_MBP = 1 << 4;
export const DBN_FLAG_BAD_TS_RECV = 1 << 3;
export const DBN_FLAG_MAYBE_BAD_BOOK = 1 << 2;

export interface DatabentoNormalizeOptions {
  readonly resolveFigi?: (symbol: string) => string;
  readonly includeRaw?: boolean;
  /** Used when a record carries only instrument_id, which happens without map_symbols. */
  readonly symbolForInstrumentId?: (instrumentId: number) => string | undefined;
}

/**
 * Databento renders 64-bit fields as JSON strings in some versions and as numbers in others, so
 * both are accepted. The number path is only safe because json.ts quoted anything too long for a
 * double before parsing.
 */
function int64(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    try {
      return BigInt(value.trim());
    } catch (error) {
      throw new SchemaError(`cannot read ${field} as an integer: ${value}`, {
        provider: PROVIDER,
        field,
        cause: error,
      });
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  throw new SchemaError(`expected an integer at ${field}, got ${String(value)}`, {
    provider: PROVIDER,
    field,
  });
}

/** Fixed-point int64 to a float price. Returns undefined for an absent level. */
export function dbnPrice(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = int64(value, field);
  if (n === UNDEF_PRICE || n === -UNDEF_PRICE) return undefined;
  return Number(n) / PRICE_SCALE;
}

function requirePrice(value: unknown, field: string): number {
  const px = dbnPrice(value, field);
  if (px === undefined) {
    throw new SchemaError(`${field} is absent on a record that requires it`, {
      provider: PROVIDER,
      field,
    });
  }
  return px;
}

function size(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return Number(value);
  throw new SchemaError(`expected a size at ${field}, got ${String(value)}`, {
    provider: PROVIDER,
    field,
  });
}

function flagsOf(value: unknown): number {
  if (typeof value !== 'number') return 0;
  return (value & DBN_FLAG_SNAPSHOT) !== 0 ? CdmFlags.Snapshot : 0;
}

interface RecordHeader {
  readonly ts_event: unknown;
  readonly instrument_id?: unknown;
}

function header(record: Record<string, unknown>): RecordHeader {
  const hd = record['hd'];
  if (typeof hd !== 'object' || hd === null) {
    throw new SchemaError('databento record has no hd header', { provider: PROVIDER, field: 'hd' });
  }
  return hd as RecordHeader;
}

function symbolOf(
  record: Record<string, unknown>,
  hd: RecordHeader,
  options: DatabentoNormalizeOptions,
): string {
  if (typeof record['symbol'] === 'string' && record['symbol'].length > 0) return record['symbol'];
  const instrumentId = typeof hd.instrument_id === 'number' ? hd.instrument_id : undefined;
  const mapped =
    instrumentId === undefined ? undefined : options.symbolForInstrumentId?.(instrumentId);
  if (mapped) return mapped;
  throw new SchemaError(
    'databento record carries no symbol; request it with map_symbols=true',
    { provider: PROVIDER, field: 'symbol' },
  );
}

const INTERVAL_NS: Readonly<Record<BarInterval, bigint>> = {
  '1m': 60_000n * NS_PER_MS,
  '1d': 86_400_000n * NS_PER_MS,
};

function levels(record: Record<string, unknown>): Record<string, unknown>[] {
  const raw = record['levels'];
  if (!Array.isArray(raw)) {
    throw new SchemaError('databento mbp record has no levels array', {
      provider: PROVIDER,
      field: 'levels',
    });
  }
  return raw as Record<string, unknown>[];
}

/**
 * One Databento JSON record to one CDM message. The caller says which schema it requested, because
 * the record itself does not name it — rtype is numeric and overlaps across schemas.
 */
export function normalizeDatabentoRecord(
  payload: unknown,
  schema: Schema,
  options: DatabentoNormalizeOptions = {},
): MarketMessage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  // Metadata and symbol-mapping records share the stream with data records.
  if (record['hd'] === undefined) return undefined;

  const hd = header(record);
  const symbol = symbolOf(record, hd, options);
  const resolveFigi = options.resolveFigi ?? (() => UNRESOLVED_FIGI);
  const base = {
    figi: resolveFigi(symbol),
    symbol,
    provider: PROVIDER,
    tsEvent: coerceEpochNs(int64(hd.ts_event, 'hd.ts_event'), PROVIDER, 'hd.ts_event'),
    tsConduitRecv: nowNs(),
    ...(record['sequence'] === undefined
      ? {}
      : { seq: int64(record['sequence'], 'sequence') }),
    ...(options.includeRaw === false ? {} : { raw: payload }),
  };

  switch (schema) {
    case 'quote_l1': {
      const [top] = levels(record);
      if (!top) return undefined;
      const bidPx = dbnPrice(top['bid_px'], 'levels[0].bid_px') ?? 0;
      const askPx = dbnPrice(top['ask_px'], 'levels[0].ask_px') ?? 0;
      const quote: QuoteTick = {
        ...base,
        kind: 'quote',
        bidPx,
        askPx,
        bidSz: bidPx === 0 ? 0 : size(top['bid_sz'], 'levels[0].bid_sz'),
        askSz: askPx === 0 ? 0 : size(top['ask_sz'], 'levels[0].ask_sz'),
        flags: flagsOf(record['flags']),
      };
      return quote;
    }

    case 'trades': {
      const trade: TradeTick = {
        ...base,
        kind: 'trade',
        px: requirePrice(record['price'], 'price'),
        sz: size(record['size'], 'size'),
        flags: flagsOf(record['flags']),
      };
      return trade;
    }

    case 'bars_1m':
    case 'bars_1d': {
      const interval: BarInterval = schema === 'bars_1m' ? '1m' : '1d';
      const bar: Bar = {
        ...base,
        kind: 'bar',
        interval,
        tsEventEnd: base.tsEvent + INTERVAL_NS[interval],
        open: requirePrice(record['open'], 'open'),
        high: requirePrice(record['high'], 'high'),
        low: requirePrice(record['low'], 'low'),
        close: requirePrice(record['close'], 'close'),
        volume: size(record['volume'], 'volume'),
      };
      return bar;
    }

    case 'depth_10': {
      const bids: DepthLevel[] = [];
      const asks: DepthLevel[] = [];
      for (const [i, level] of levels(record).entries()) {
        const bidPx = dbnPrice(level['bid_px'], `levels[${i}].bid_px`);
        if (bidPx !== undefined) {
          bids.push({
            px: bidPx,
            sz: size(level['bid_sz'], `levels[${i}].bid_sz`),
            ...(typeof level['bid_ct'] === 'number' ? { orders: level['bid_ct'] } : {}),
          });
        }
        const askPx = dbnPrice(level['ask_px'], `levels[${i}].ask_px`);
        if (askPx !== undefined) {
          asks.push({
            px: askPx,
            sz: size(level['ask_sz'], `levels[${i}].ask_sz`),
            ...(typeof level['ask_ct'] === 'number' ? { orders: level['ask_ct'] } : {}),
          });
        }
      }
      const depth: DepthSnapshot = { ...base, kind: 'depth', bids, asks };
      return depth;
    }
  }
}
