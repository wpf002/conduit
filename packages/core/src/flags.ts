/**
 * The only trade/quote semantics that exist across Polygon, Alpaca, and Databento. Everything
 * else — SIP condition codes, Alpaca's char codes, Databento's action/side — stays in `raw`.
 * See docs/cdm-draft.md rows 4 and 5.
 */
export const CdmFlags = {
  None: 0,
  /** Below the round-lot threshold for the venue. */
  OddLot: 1 << 0,
  /** Reported late or out of sequence relative to the venue's own ordering. */
  OutOfSequence: 1 << 1,
  /** Not eligible for trade-through protection (Rule 611). */
  TradeThroughExempt: 1 << 2,
  /** Instrument was halted at the time of the message. */
  Halted: 1 << 3,
  /** Point-in-time snapshot rather than an incremental update. */
  Snapshot: 1 << 4,
  /** Computed by Conduit rather than reported by the venue. */
  Derived: 1 << 5,
  /** Corrected or cancelled a previously reported message. */
  Correction: 1 << 6,
} as const;

export type CdmFlag = (typeof CdmFlags)[keyof typeof CdmFlags];

export function hasFlag(flags: number | undefined, flag: CdmFlag): boolean {
  return ((flags ?? 0) & flag) !== 0;
}

export function withFlags(...flags: readonly CdmFlag[]): number {
  let out = 0;
  for (const f of flags) out |= f;
  return out;
}

export function describeFlags(flags: number | undefined): string[] {
  const out: string[] = [];
  for (const [name, bit] of Object.entries(CdmFlags)) {
    if (bit !== 0 && hasFlag(flags, bit as CdmFlag)) out.push(name);
  }
  return out;
}
