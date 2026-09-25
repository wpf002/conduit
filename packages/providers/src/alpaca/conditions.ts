import type { ProviderId } from '@conduit/core';
import { conditionFlags } from '../conditions.js';

const PROVIDER: ProviderId = 'alpaca';

/**
 * Alpaca reports CTA/UTP conditions as single characters — a different vocabulary from Massive's
 * integers for the same underlying SIP conditions. Its table lives behind
 * /v2/stocks/meta/conditions, so nothing is mapped until a consumer registers it.
 */
export function alpacaTradeFlags(conditions: unknown, size: number | undefined): number {
  return conditionFlags(PROVIDER, conditions, size);
}
