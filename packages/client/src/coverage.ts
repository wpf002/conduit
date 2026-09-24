import { CoverageError, type AssetClass, type ProviderAdapter, type ProviderId, type Schema } from '@conduit/core';
import type { CoverageOverride, ResolvedConfig } from './config.js';

export interface CoverageQuery {
  readonly schema: Schema;
  readonly assetClass: AssetClass;
  readonly symbols: readonly string[];
}

function coversSymbols(override: CoverageOverride | undefined, symbols: readonly string[]): boolean {
  if (!override?.symbols) return true;
  const allowed = new Set(override.symbols);
  return symbols.every((s) => allowed.has(s));
}

function coversAssetClass(override: CoverageOverride | undefined, assetClass: AssetClass): boolean {
  if (!override?.assetClasses) return true;
  return override.assetClasses.includes(assetClass);
}

/**
 * Step one of routing: which of the user's own keys can serve this request at all. This is a
 * capability question, not a health question — a provider that covers the request but is currently
 * down still belongs in the list, because failover needs somewhere to fail back to.
 */
export function coveringProviders(
  config: ResolvedConfig,
  query: CoverageQuery,
): readonly ProviderAdapter[] {
  const covering = config.providers.filter((adapter) => {
    const override = config.coverage[adapter.id];
    return (
      adapter.supports(query.schema, query.assetClass) &&
      coversAssetClass(override, query.assetClass) &&
      coversSymbols(override, query.symbols)
    );
  });

  // The preferred provider goes first; the rest keep the configured order.
  const preferred = config.preferredProvider;
  if (preferred === undefined) return covering;
  const head = covering.filter((a) => a.id === preferred);
  return [...head, ...covering.filter((a) => a.id !== preferred)];
}

/** Explains what was configured, so a coverage gap is actionable rather than just an empty list. */
export function assertCoverage(
  config: ResolvedConfig,
  query: CoverageQuery,
  covering: readonly ProviderAdapter[],
): void {
  if (covering.length > 0) return;
  const configured = config.providers
    .map((a) => `${a.id}(${[...a.capabilities].sort().join('|') || 'none'})`)
    .join(', ');
  throw new CoverageError(
    `no configured provider covers ${query.schema} for ${query.assetClass}. Configured: ${configured}`,
    { schema: query.schema, assetClass: query.assetClass },
  );
}

export function providerIds(adapters: readonly ProviderAdapter[]): ProviderId[] {
  return adapters.map((a) => a.id);
}
