import { CdmFlags } from '@conduit/core';

/**
 * Polygon reports SIP condition codes in its own numbering. There is no cross-vendor equivalent
 * (docs/cdm-draft.md row 4), so only codes whose Conduit-level meaning is unambiguous are mapped;
 * everything else stays in `raw`.
 *
 * This table is deliberately small. Entries get added when a captured fixture confirms the code,
 * not from guesswork — a wrong flag is worse than an absent one, because a strategy will act on it.
 */
export const POLYGON_TRADE_CONDITION_FLAGS: Readonly<Record<number, number>> = {
  // Verified against Polygon's published stock trade conditions list.
  2: CdmFlags.OutOfSequence, // Average Price Trade
  7: CdmFlags.OutOfSequence, // Cash Sale, settles same day, reported out of band
  12: CdmFlags.TradeThroughExempt, // Form T / extended hours
  13: CdmFlags.TradeThroughExempt, // Extended hours, sold out of sequence
  15: CdmFlags.OutOfSequence, // Sold Last
  16: CdmFlags.OutOfSequence, // Sold Out of Sequence
  21: CdmFlags.OutOfSequence, // Prior Reference Price
  37: CdmFlags.OddLot, // Odd Lot Trade
};

/** Round lot for US equities. Below this a trade is an odd lot regardless of condition codes. */
const ROUND_LOT = 100;

/**
 * Conditions are an integer array on trades and a scalar on quotes, so both shapes are accepted.
 * Odd-lot is also derived from size when no condition code says so, and marked Derived to make
 * clear the venue did not report it.
 */
export function polygonTradeFlags(conditions: unknown, size: number | undefined): number {
  let flags = 0;
  const list = Array.isArray(conditions) ? conditions : conditions === undefined ? [] : [conditions];
  for (const c of list) {
    if (typeof c !== 'number') continue;
    flags |= POLYGON_TRADE_CONDITION_FLAGS[c] ?? 0;
  }
  if (size !== undefined && size > 0 && size < ROUND_LOT && (flags & CdmFlags.OddLot) === 0) {
    flags |= CdmFlags.OddLot | CdmFlags.Derived;
  }
  return flags;
}
