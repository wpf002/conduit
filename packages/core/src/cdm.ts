import type { AssetClass, BarInterval, ProviderId } from './ids.js';
import { isFigi, UNRESOLVED_FIGI } from './ids.js';
import { SchemaError } from './errors.js';

export type CdmKind = 'quote' | 'trade' | 'bar' | 'depth' | 'control';

export interface CdmBase {
  /** FIGI, or UNRESOLVED_FIGI before @conduit/symbology has resolved the instrument. */
  readonly figi: string;
  /** Exactly as the provider spelled it. The provider-neutral identity is `figi`. */
  readonly symbol: string;
  readonly provider: ProviderId;
  /** Venue timestamp, nanoseconds. */
  readonly tsEvent: bigint;
  /** Conduit ingress, nanoseconds. Always >= tsEvent in practice, never assumed to be. */
  readonly tsConduitRecv: bigint;
  /** Provider sequence number where one exists. Polygon and Databento have one; Alpaca does not. */
  readonly seq?: bigint;
  readonly flags?: number;
  /**
   * The original provider payload, for condition codes and venue identity, which have no shared
   * vocabulary across vendors. Consumers reading only prices and sizes never touch this.
   */
  readonly raw?: unknown;
}

export interface QuoteTick extends CdmBase {
  readonly kind: 'quote';
  readonly bidPx: number;
  readonly bidSz: number;
  readonly askPx: number;
  readonly askSz: number;
  /**
   * The provider's own venue code, verbatim, as a string. Deliberately **not** normalized to a MIC:
   * the per-vendor code tables are not public, and a wrong venue label is worse than an
   * untranslated one. Resolve it with a map you trust via `micFor` in @conduit/providers.
   */
  readonly bidVenue?: string;
  readonly askVenue?: string;
}

export interface TradeTick extends CdmBase {
  readonly kind: 'trade';
  readonly px: number;
  readonly sz: number;
  readonly tradeId?: string;
  /** The provider's own venue code, verbatim. See the note on QuoteTick.bidVenue. */
  readonly venue?: string;
}

export interface Bar extends CdmBase {
  readonly kind: 'bar';
  readonly interval: BarInterval;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  /** tsEvent is the bar's opening timestamp; this is its close. */
  readonly tsEventEnd: bigint;
  readonly vwap?: number;
  readonly trades?: number;
}

export interface DepthLevel {
  readonly px: number;
  readonly sz: number;
  readonly orders?: number;
}

export interface DepthSnapshot extends CdmBase {
  readonly kind: 'depth';
  /** Descending by price. */
  readonly bids: readonly DepthLevel[];
  /** Ascending by price. */
  readonly asks: readonly DepthLevel[];
}

export type ControlKind =
  | 'provider_switch'
  | 'provider_degraded'
  | 'provider_recovered'
  | 'sequence_gap';

/**
 * Emitted on the consumer's own stream so a strategy can react to a failover instead of
 * discovering it from a gap in the data.
 */
export interface ControlMessage {
  readonly kind: 'control';
  readonly control: ControlKind;
  readonly provider: ProviderId;
  /** Set on 'provider_switch'. */
  readonly previousProvider?: ProviderId;
  readonly reason: string;
  readonly symbols: readonly string[];
  readonly tsConduitRecv: bigint;
  /** Set on 'sequence_gap': how many messages the provider's own numbering says are missing. */
  readonly gap?: {
    readonly symbol: string;
    readonly expectedSeq: bigint;
    readonly receivedSeq: bigint;
    readonly missing: bigint;
  };
}

export type MarketMessage = QuoteTick | TradeTick | Bar | DepthSnapshot;
export type CdmMessage = MarketMessage | ControlMessage;

export interface Instrument {
  readonly figi: string;
  readonly ticker: string;
  readonly name?: string;
  readonly assetClass: AssetClass;
  readonly exchangeMic?: string;
  readonly currency: string;
  readonly active: boolean;
}

// ------------------------------------------------------------------------ guards
export const isQuote = (m: CdmMessage): m is QuoteTick => m.kind === 'quote';
export const isTrade = (m: CdmMessage): m is TradeTick => m.kind === 'trade';
export const isBar = (m: CdmMessage): m is Bar => m.kind === 'bar';
export const isDepth = (m: CdmMessage): m is DepthSnapshot => m.kind === 'depth';
export const isControl = (m: CdmMessage): m is ControlMessage => m.kind === 'control';
export const isMarketMessage = (m: CdmMessage): m is MarketMessage => m.kind !== 'control';

// -------------------------------------------------------------------- invariants
function requireFinite(value: number, field: string, provider: ProviderId): void {
  if (!Number.isFinite(value)) {
    throw new SchemaError(`${field} is not finite: ${value}`, { provider, field });
  }
}

function requireNonNegative(value: number, field: string, provider: ProviderId): void {
  requireFinite(value, field, provider);
  if (value < 0) throw new SchemaError(`${field} is negative: ${value}`, { provider, field });
}

/**
 * Asserted in tests against every replayed fixture, and by adapters in development. Throwing
 * SchemaError here is how a vendor payload change surfaces as a typed error rather than a NaN
 * propagating into a strategy.
 */
export function assertCdmInvariants(m: CdmMessage): void {
  if (isControl(m)) {
    if (m.tsConduitRecv <= 0n) throw new SchemaError('control tsConduitRecv must be positive');
    return;
  }

  const { provider } = m;
  if (m.figi !== UNRESOLVED_FIGI && !isFigi(m.figi)) {
    throw new SchemaError(`figi is neither empty nor a valid FIGI: ${m.figi}`, {
      provider,
      field: 'figi',
    });
  }
  if (m.symbol.length === 0) {
    throw new SchemaError('symbol is empty', { provider, field: 'symbol' });
  }
  if (m.tsEvent <= 0n) {
    throw new SchemaError(`tsEvent must be positive, got ${m.tsEvent}`, {
      provider,
      field: 'tsEvent',
    });
  }
  if (m.tsConduitRecv <= 0n) {
    throw new SchemaError(`tsConduitRecv must be positive, got ${m.tsConduitRecv}`, {
      provider,
      field: 'tsConduitRecv',
    });
  }

  switch (m.kind) {
    case 'quote': {
      requireNonNegative(m.bidPx, 'bidPx', provider);
      requireNonNegative(m.askPx, 'askPx', provider);
      requireNonNegative(m.bidSz, 'bidSz', provider);
      requireNonNegative(m.askSz, 'askSz', provider);
      // A one-sided quote is normal; a crossed two-sided quote is not.
      if (m.bidPx > 0 && m.askPx > 0 && m.bidPx > m.askPx) {
        throw new SchemaError(`crossed quote: bid ${m.bidPx} > ask ${m.askPx}`, {
          provider,
          field: 'bidPx',
        });
      }
      return;
    }
    case 'trade': {
      requireNonNegative(m.px, 'px', provider);
      requireNonNegative(m.sz, 'sz', provider);
      return;
    }
    case 'bar': {
      for (const [field, value] of [
        ['open', m.open],
        ['high', m.high],
        ['low', m.low],
        ['close', m.close],
      ] as const) {
        requireNonNegative(value, field, provider);
      }
      requireNonNegative(m.volume, 'volume', provider);
      if (m.high < m.low) {
        throw new SchemaError(`bar high ${m.high} below low ${m.low}`, { provider, field: 'high' });
      }
      if (m.open > m.high || m.close > m.high || m.open < m.low || m.close < m.low) {
        throw new SchemaError('bar open/close outside high/low', { provider, field: 'open' });
      }
      if (m.tsEventEnd <= m.tsEvent) {
        throw new SchemaError('bar tsEventEnd must be after tsEvent', {
          provider,
          field: 'tsEventEnd',
        });
      }
      return;
    }
    case 'depth': {
      for (const [i, level] of m.bids.entries()) {
        requireNonNegative(level.px, `bids[${i}].px`, provider);
        requireNonNegative(level.sz, `bids[${i}].sz`, provider);
        const prev = m.bids[i - 1];
        if (prev && level.px > prev.px) {
          throw new SchemaError(`bids not descending at ${i}`, { provider, field: 'bids' });
        }
      }
      for (const [i, level] of m.asks.entries()) {
        requireNonNegative(level.px, `asks[${i}].px`, provider);
        requireNonNegative(level.sz, `asks[${i}].sz`, provider);
        const prev = m.asks[i - 1];
        if (prev && level.px < prev.px) {
          throw new SchemaError(`asks not ascending at ${i}`, { provider, field: 'asks' });
        }
      }
      return;
    }
  }
}
