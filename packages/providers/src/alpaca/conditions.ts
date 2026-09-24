import { CdmFlags } from '@conduit/core';

/**
 * Alpaca reports CTA/UTP condition codes as single characters, a different vocabulary from
 * Polygon's integers for the same underlying SIP conditions (docs/cdm-draft.md row 4). Only codes
 * with an unambiguous Conduit-level meaning are mapped; the rest stay in `raw`.
 */
export const ALPACA_TRADE_CONDITION_FLAGS: Readonly<Record<string, number>> = {
  I: CdmFlags.OddLot, // Odd lot trade
  L: CdmFlags.OutOfSequence, // Sold last
  Z: CdmFlags.OutOfSequence, // Sold out of sequence
  T: CdmFlags.TradeThroughExempt, // Form T, pre/post market
  U: CdmFlags.TradeThroughExempt, // Extended hours, sold out of sequence
  W: CdmFlags.OutOfSequence, // Average price trade
  P: CdmFlags.OutOfSequence, // Prior reference price
  H: CdmFlags.Correction, // Price variation / corrected
};

const ROUND_LOT = 100;

export function alpacaTradeFlags(conditions: unknown, size: number | undefined): number {
  let flags = 0;
  const list = Array.isArray(conditions) ? conditions : [];
  for (const c of list) {
    if (typeof c !== 'string') continue;
    flags |= ALPACA_TRADE_CONDITION_FLAGS[c.toUpperCase()] ?? 0;
  }
  if (size !== undefined && size > 0 && size < ROUND_LOT && (flags & CdmFlags.OddLot) === 0) {
    flags |= CdmFlags.OddLot | CdmFlags.Derived;
  }
  return flags;
}
