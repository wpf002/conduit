import {
  SchemaError,
  UNRESOLVED_FIGI,
  isoToNs,
  nowNs,
  NS_PER_MS,
  type Bar,
  type MarketMessage,
  type QuoteTick,
  type TradeTick,
} from '@conduit/core';
import { alpacaMic } from '../venues.js';
import { alpacaTradeFlags } from './conditions.js';

const PROVIDER = 'alpaca' as const;
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
        ...(alpacaMic(msg['bx']) ? { bidVenue: alpacaMic(msg['bx'])! } : {}),
        ...(alpacaMic(msg['ax']) ? { askVenue: alpacaMic(msg['ax'])! } : {}),
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
        ...(alpacaMic(msg['x']) ? { venue: alpacaMic(msg['x'])! } : {}),
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
