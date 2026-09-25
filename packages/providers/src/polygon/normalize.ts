import {
  CdmFlags,
  NS_PER_MS,
  SchemaError,
  UNRESOLVED_FIGI,
  nowNs,
  type Bar,
  type MarketMessage,
  type QuoteTick,
  type TradeTick,
} from '@conduit/core';
import { coerceEpochNs } from '../epoch.js';
import { polygonMic } from '../venues.js';
import { polygonTradeFlags } from './conditions.js';

const PROVIDER = 'polygon' as const;

/**
 * Massive (formerly Polygon) switched stocks quote sizes from round lots to shares on 2025-11-03,
 * across the REST API, the websocket stream, and flat files. Trade sizes were always shares.
 *
 * So the default is 'shares' and no multiplier is applied. The 'lots' option exists for replaying
 * flat files dated before the cutover, which were still in round lots while the historical
 * regeneration ran. See docs/cdm-draft.md row 7.
 */
const LOT_SIZE = 100;
const QUOTE_SIZE_CUTOVER = '2025-11-03';

export interface PolygonNormalizeOptions {
  /** Maps a Polygon ticker to a FIGI. Returns UNRESOLVED_FIGI until Phase 3 symbology is wired. */
  readonly resolveFigi?: (symbol: string) => string;
  /**
   * Defaults to 'shares', which is what Massive has reported since 2025-11-03. Pass 'lots' only
   * when replaying flat files from before that date.
   */
  readonly quoteSizeUnits?: 'lots' | 'shares';
  /** Attach the original payload. On by default; the router turns it off for depth-heavy feeds. */
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

/** Timestamps arrive as strings when json.ts had to quote them to keep all 19 digits. */
function ts(value: unknown, field: string): bigint {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return coerceEpochNs(value, PROVIDER, field);
  }
  throw new SchemaError(`expected a timestamp at ${field}, got ${String(value)}`, {
    provider: PROVIDER,
    field,
  });
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SchemaError(`expected a non-empty string at ${field}`, {
      provider: PROVIDER,
      field,
    });
  }
  return value;
}

/**
 * One Polygon websocket payload to one CDM message. Returns undefined for payloads that are valid
 * but carry no market data (status frames, second aggregates we did not subscribe to), and throws
 * SchemaError for payloads that claim a type but do not match its documented shape.
 */
export function normalizePolygonMessage(
  payload: unknown,
  options: PolygonNormalizeOptions = {},
): MarketMessage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const msg = payload as Record<string, unknown>;
  const ev = msg['ev'];
  if (typeof ev !== 'string') return undefined;

  const tsConduitRecv = nowNs();
  const resolveFigi = options.resolveFigi ?? (() => UNRESOLVED_FIGI);
  const quoteMultiplier = options.quoteSizeUnits === 'lots' ? LOT_SIZE : 1;
  const includeRaw = options.includeRaw ?? true;
  const raw = includeRaw ? { raw: payload } : {};

  switch (ev) {
    case 'Q': {
      const symbol = str(msg['sym'], 'sym');
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
        ...(polygonMic(msg['bx']) ? { bidVenue: polygonMic(msg['bx'])! } : {}),
        ...(polygonMic(msg['ax']) ? { askVenue: polygonMic(msg['ax'])! } : {}),
        ...(typeof msg['q'] === 'number' ? { seq: BigInt(msg['q']) } : {}),
        ...raw,
      };
      return quote;
    }

    case 'T': {
      const symbol = str(msg['sym'], 'sym');
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
        flags: polygonTradeFlags(msg['c'], size),
        ...(typeof msg['i'] === 'string' || typeof msg['i'] === 'number'
          ? { tradeId: String(msg['i']) }
          : {}),
        ...(polygonMic(msg['x']) ? { venue: polygonMic(msg['x'])! } : {}),
        ...(typeof msg['q'] === 'number' ? { seq: BigInt(msg['q']) } : {}),
        ...raw,
      };
      return trade;
    }

    // AM is the minute aggregate; A is the second aggregate, which Conduit does not expose.
    case 'AM': {
      const symbol = str(msg['sym'], 'sym');
      const start = ts(msg['s'], 's');
      const bar: Bar = {
        kind: 'bar',
        figi: resolveFigi(symbol),
        symbol,
        provider: PROVIDER,
        tsEvent: start,
        tsEventEnd:
          msg['e'] === undefined ? start + 60_000n * NS_PER_MS : ts(msg['e'], 'e'),
        tsConduitRecv,
        interval: '1m',
        open: num(msg['o'], 'o'),
        high: num(msg['h'], 'h'),
        low: num(msg['l'], 'l'),
        close: num(msg['c'], 'c'),
        volume: num(msg['v'], 'v'),
        ...(typeof msg['vw'] === 'number' ? { vwap: msg['vw'] } : {}),
        ...raw,
      };
      return bar;
    }

    default:
      return undefined;
  }
}

/** v2 snapshot payload for one ticker to a QuoteTick. */
export function normalizePolygonSnapshot(
  entry: unknown,
  options: PolygonNormalizeOptions = {},
): QuoteTick | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const t = entry as Record<string, unknown>;
  const lastQuote = t['lastQuote'];
  if (typeof lastQuote !== 'object' || lastQuote === null) return undefined;
  const q = lastQuote as Record<string, unknown>;

  const symbol = str(t['ticker'], 'ticker');
  const resolveFigi = options.resolveFigi ?? (() => UNRESOLVED_FIGI);
  const quoteMultiplier = options.quoteSizeUnits === 'lots' ? LOT_SIZE : 1;

  return {
    kind: 'quote',
    figi: resolveFigi(symbol),
    symbol,
    provider: PROVIDER,
    tsEvent: ts(q['t'], 'lastQuote.t'),
    tsConduitRecv: nowNs(),
    bidPx: num(q['p'], 'lastQuote.p'),
    bidSz: num(q['s'], 'lastQuote.s') * quoteMultiplier,
    askPx: num(q['P'], 'lastQuote.P'),
    askSz: num(q['S'], 'lastQuote.S') * quoteMultiplier,
    flags: CdmFlags.Snapshot,
    ...(options.includeRaw === false ? {} : { raw: entry }),
  };
}
