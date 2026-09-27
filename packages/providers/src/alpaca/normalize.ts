import {
  CdmFlags,
  SchemaError,
  UNRESOLVED_FIGI,
  isoToNs,
  nowNs,
  NS_PER_MS,
  type Bar,
  type InstrumentSnapshot,
  type MarketMessage,
  type QuoteTick,
  type TradeTick,
} from '@conduit/core';
import { venueCode } from '../venues.js';
import { alpacaTradeFlags } from './conditions.js';

const PROVIDER = 'alpaca' as const;

/**
 * Alpaca documents stocks quote sizes as round lots, and still does — unlike Massive, which moved
 * to shares on 2025-11-03. The two feeds genuinely disagree, so the multiplier is per adapter, not
 * shared. Trade sizes are shares on both. See docs/cdm-draft.md row 7.
 */
const LOT_SIZE = 100;
const MINUTE_NS = 60_000n * NS_PER_MS;
const DAY_NS = 86_400_000n * NS_PER_MS;

export interface AlpacaNormalizeOptions {
  readonly resolveFigi?: (symbol: string) => string;
  readonly quoteSizeUnits?: 'lots' | 'shares';
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

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SchemaError(`expected a non-empty string at ${field}`, { provider: PROVIDER, field });
  }
  return value;
}

/** Alpaca sends RFC-3339 with nanosecond precision, which Date.parse would truncate. */
function ts(value: unknown, field: string): bigint {
  const raw = str(value, field);
  try {
    return isoToNs(raw);
  } catch (error) {
    throw new SchemaError(`cannot read ${field} as RFC-3339: ${raw}`, {
      provider: PROVIDER,
      field,
      cause: error,
    });
  }
}

/**
 * Alpaca's /v2/stocks/{symbol}/snapshot response to an InstrumentSnapshot.
 *
 * Shape verified against the live endpoint on 2026-09-27: dailyBar, latestQuote, latestTrade,
 * minuteBar, prevDailyBar and symbol, with bars as {o,h,l,c,v,n,vw,t} and RFC-3339 timestamps
 * carrying eight or nine fractional digits.
 */
export function normalizeAlpacaSnapshot(
  payload: unknown,
  symbol: string,
  options: AlpacaNormalizeOptions = {},
): InstrumentSnapshot | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;

  const obj = (key: string): Record<string, unknown> | undefined => {
    const value = record[key];
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  };
  const optNum = (source: Record<string, unknown> | undefined, key: string): number | undefined => {
    const value = source?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };

  const latestTrade = obj('latestTrade');
  const latestQuote = obj('latestQuote');
  const dailyBar = obj('dailyBar');
  const prevDailyBar = obj('prevDailyBar');
  const quoteMultiplier = (options.quoteSizeUnits ?? 'lots') === 'lots' ? LOT_SIZE : 1;

  // The event time is the freshest thing in the payload: the last trade, else the last quote.
  const eventSource = latestTrade?.['t'] ?? latestQuote?.['t'] ?? dailyBar?.['t'];
  if (typeof eventSource !== 'string') return undefined;

  const day = dailyBar
    ? {
        open: optNum(dailyBar, 'o') ?? 0,
        high: optNum(dailyBar, 'h') ?? 0,
        low: optNum(dailyBar, 'l') ?? 0,
        close: optNum(dailyBar, 'c') ?? 0,
        volume: optNum(dailyBar, 'v') ?? 0,
        ...(optNum(dailyBar, 'vw') === undefined ? {} : { vwap: optNum(dailyBar, 'vw')! }),
        ...(optNum(dailyBar, 'n') === undefined ? {} : { trades: optNum(dailyBar, 'n')! }),
      }
    : undefined;

  const bidPx = optNum(latestQuote, 'bp');
  const askPx = optNum(latestQuote, 'ap');
  const bidSz = optNum(latestQuote, 'bs');
  const askSz = optNum(latestQuote, 'as');

  return {
    kind: 'snapshot',
    figi: (options.resolveFigi ?? (() => UNRESOLVED_FIGI))(symbol),
    symbol,
    provider: PROVIDER,
    tsEvent: ts(eventSource, 'latestTrade.t'),
    tsConduitRecv: nowNs(),
    flags: CdmFlags.Snapshot,
    ...(optNum(latestTrade, 'p') === undefined ? {} : { lastPx: optNum(latestTrade, 'p')! }),
    ...(optNum(latestTrade, 's') === undefined ? {} : { lastSz: optNum(latestTrade, 's')! }),
    ...(bidPx === undefined ? {} : { bidPx }),
    ...(askPx === undefined ? {} : { askPx }),
    ...(bidSz === undefined ? {} : { bidSz: bidSz * quoteMultiplier }),
    ...(askSz === undefined ? {} : { askSz: askSz * quoteMultiplier }),
    ...(day ? { day } : {}),
    ...(optNum(prevDailyBar, 'c') === undefined ? {} : { prevClose: optNum(prevDailyBar, 'c')! }),
    ...(options.includeRaw === false ? {} : { raw: payload }),
  };
}

/**
 * One Alpaca v2 stream payload to one CDM message. Alpaca has no sequence number of any kind
 * (docs/cdm-draft.md row 3), so `seq` is always absent and gap detection is not possible on this
 * feed.
 */
export function normalizeAlpacaMessage(
  payload: unknown,
  options: AlpacaNormalizeOptions = {},
): MarketMessage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const msg = payload as Record<string, unknown>;
  const type = msg['T'];
  if (typeof type !== 'string') return undefined;

  const tsConduitRecv = nowNs();
  const resolveFigi = options.resolveFigi ?? (() => UNRESOLVED_FIGI);
  const quoteMultiplier = (options.quoteSizeUnits ?? 'lots') === 'lots' ? LOT_SIZE : 1;
  const raw = options.includeRaw === false ? {} : { raw: payload };

  switch (type) {
    case 'q': {
      const symbol = str(msg['S'], 'S');
      const quote: QuoteTick = {
        kind: 'quote',
        figi: resolveFigi(symbol),
        symbol,
        provider: PROVIDER,
        tsEvent: ts(msg['t'], 't'),
        tsConduitRecv,
        bidPx: num(msg['bp'], 'bp'),
        bidSz: num(msg['bs'], 'bs') * quoteMultiplier,
        askPx: num(msg['ap'], 'ap'),
        askSz: num(msg['as'], 'as') * quoteMultiplier,
        ...(venueCode(msg['bx']) ? { bidVenue: venueCode(msg['bx'])! } : {}),
        ...(venueCode(msg['ax']) ? { askVenue: venueCode(msg['ax'])! } : {}),
        ...raw,
      };
      return quote;
    }

    case 't': {
      const symbol = str(msg['S'], 'S');
      const size = num(msg['s'], 's');
      const trade: TradeTick = {
        kind: 'trade',
        figi: resolveFigi(symbol),
        symbol,
        provider: PROVIDER,
        tsEvent: ts(msg['t'], 't'),
        tsConduitRecv,
        px: num(msg['p'], 'p'),
        sz: size,
        flags: alpacaTradeFlags(msg['c'], size),
        ...(typeof msg['i'] === 'number' || typeof msg['i'] === 'string'
          ? { tradeId: String(msg['i']) }
          : {}),
        ...(venueCode(msg['x']) ? { venue: venueCode(msg['x'])! } : {}),
        ...raw,
      };
      return trade;
    }

    // 'b' minute bar, 'd' daily bar, 'u' updated (corrected) minute bar.
    case 'b':
    case 'd':
    case 'u': {
      const symbol = str(msg['S'], 'S');
      const start = ts(msg['t'], 't');
      const interval = type === 'd' ? '1d' : '1m';
      const bar: Bar = {
        kind: 'bar',
        figi: resolveFigi(symbol),
        symbol,
        provider: PROVIDER,
        tsEvent: start,
        tsEventEnd: start + (interval === '1d' ? DAY_NS : MINUTE_NS),
        tsConduitRecv,
        interval,
        open: num(msg['o'], 'o'),
        high: num(msg['h'], 'h'),
        low: num(msg['l'], 'l'),
        close: num(msg['c'], 'c'),
        volume: num(msg['v'], 'v'),
        ...(typeof msg['vw'] === 'number' ? { vwap: msg['vw'] } : {}),
        ...(typeof msg['n'] === 'number' ? { trades: msg['n'] } : {}),
        ...raw,
      };
      return bar;
    }

    default:
      // success, error, subscription, and the corrections/cancel-error types Conduit does not model.
      return undefined;
  }
}
