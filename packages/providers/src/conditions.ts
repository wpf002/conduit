import { CdmFlags, type ProviderId } from '@conduit/core';

/**
 * Condition codes have no cross-vendor vocabulary (docs/cdm-draft.md row 4), and neither vendor
 * publishes its code table outside an authenticated reference endpoint — Massive serves it from
 * /v3/reference/conditions and Alpaca from /v2/stocks/meta/conditions.
 *
 * So this ships **no** code-to-flag mappings. An earlier version of this file carried eight numeric
 * mappings for Massive under a comment claiming they were verified against its published conditions
 * list; they were not verified, and a wrong flag is worse than an absent one because a strategy
 * filtering on OddLot or TradeThroughExempt acts on it silently.
 *
 * Populate it from the vendor's own endpoint and Conduit will use it:
 *
 *   registerConditionFlags('polygon', { 37: CdmFlags.OddLot });
 */
const registries = new Map<ProviderId, Map<string, number>>();

export function registerConditionFlags(
  provider: ProviderId,
  entries: Readonly<Record<string | number, number>>,
): void {
  const map = registries.get(provider) ?? new Map<string, number>();
  for (const [code, flags] of Object.entries(entries)) map.set(String(code).toUpperCase(), flags);
  registries.set(provider, map);
}

export function clearConditionFlags(): void {
  registries.clear();
}

/** Round lot for US equities. Below this a trade is an odd lot whatever the codes say. */
export const ROUND_LOT = 100;

/**
 * Flags for one message. Accepts an integer array (Massive), a character array (Alpaca), or a
 * scalar. Unmapped codes contribute nothing.
 *
 * Odd lot is additionally derived from size, and marked Derived so a consumer can tell the venue did
 * not report it.
 */
export function conditionFlags(
  provider: ProviderId,
  conditions: unknown,
  size: number | undefined,
): number {
  const map = registries.get(provider);
  let flags = 0;

  if (map) {
    const list = Array.isArray(conditions)
      ? conditions
      : conditions === undefined || conditions === null
        ? []
        : [conditions];
    for (const code of list) {
      if (typeof code !== 'number' && typeof code !== 'string') continue;
      flags |= map.get(String(code).toUpperCase()) ?? 0;
    }
  }

  if (size !== undefined && size > 0 && size < ROUND_LOT && (flags & CdmFlags.OddLot) === 0) {
    flags |= CdmFlags.OddLot | CdmFlags.Derived;
  }
  return flags;
}
