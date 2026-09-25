import type { ProviderId } from '@conduit/core';
import { conditionFlags } from '../conditions.js';

const PROVIDER: ProviderId = 'polygon';

/**
 * Massive reports SIP trade conditions as an integer array on trades and a scalar on quotes. The
 * numeric table lives behind /v3/reference/conditions, so nothing is mapped until a consumer
 * registers it. See ../conditions.ts.
 */
export function polygonTradeFlags(conditions: unknown, size: number | undefined): number {
  return conditionFlags(PROVIDER, conditions, size);
}
