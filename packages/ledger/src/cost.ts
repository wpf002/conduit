import {
  ZERO_MICROS,
  micros,
  type Micros,
  type ProviderId,
  type UsageKind,
  type UsageRecord,
} from '@conduit/core';

/**
 * Cost per billable unit, in integer micro-units of the account currency. No floats anywhere in
 * this path: a per-message cost is small enough that float accumulation over a trading day drifts.
 *
 * These are defaults, and they are guesses about the user's own plan — every vendor prices by tier
 * and most flat-rate plans have a per-unit cost of zero with the subscription as the real number.
 * Override per provider; `conduit spend` reports what it was given.
 */
export interface CostModel {
  readonly perUnit: Readonly<Partial<Record<ProviderId, Partial<Record<UsageKind, number>>>>>;
  /** Flat monthly subscription in micro-units, for attributing a share of the fixed cost. */
  readonly monthly?: Readonly<Partial<Record<ProviderId, number>>>;
}

/**
 * Zero per-unit by default. A flat-rate plan genuinely costs nothing per message, and inventing a
 * number here would put a fabricated figure in a spend report.
 */
export const DEFAULT_COST_MODEL: CostModel = {
  perUnit: {
    polygon: { rest: 0, ws_message: 0, ws_subscribe: 0 },
    alpaca: { rest: 0, ws_message: 0, ws_subscribe: 0 },
    databento: { rest: 0, ws_message: 0, ws_subscribe: 0 },
    tiingo: { rest: 0, ws_message: 0, ws_subscribe: 0 },
  },
};

export function mergeCostModel(base: CostModel, override: CostModel | undefined): CostModel {
  if (!override) return base;
  const perUnit: Record<string, Partial<Record<UsageKind, number>>> = {};
  for (const [provider, kinds] of Object.entries(base.perUnit)) {
    perUnit[provider] = { ...kinds };
  }
  for (const [provider, kinds] of Object.entries(override.perUnit ?? {})) {
    perUnit[provider] = { ...perUnit[provider], ...kinds };
  }
  return {
    perUnit: perUnit as CostModel['perUnit'],
    ...(base.monthly || override.monthly
      ? { monthly: { ...base.monthly, ...override.monthly } }
      : {}),
  };
}

export function costOf(record: UsageRecord, model: CostModel): Micros {
  const perUnit = model.perUnit[record.provider]?.[record.kind];
  if (perUnit === undefined || perUnit === 0) return ZERO_MICROS;
  return micros(perUnit * record.count);
}
