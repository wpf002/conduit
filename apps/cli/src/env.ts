import { config as loadDotenv } from 'dotenv';
import {
  type AssetClass,
  type ProviderAdapter,
  type ProviderId,
  type UsageHooks,
} from '@conduit/core';
import { alpaca, databento, polygon } from '@conduit/providers';

export interface LoadedEnv {
  readonly adapters: readonly ProviderAdapter[];
  /** Providers with no key configured, so the CLI can say what is missing rather than guess. */
  readonly missing: readonly ProviderId[];
  readonly databaseUrl: string | undefined;
  readonly openFigiKey: string | undefined;
}

export interface LoadOptions {
  readonly usage?: (provider: ProviderId) => UsageHooks;
  readonly resolveFigi?: (provider: ProviderId) => (symbol: string) => string;
  /** Databento needs a dataset; there is no sensible default across asset classes. */
  readonly databentoDataset?: string;
  readonly databentoAssetClasses?: readonly AssetClass[];
}

/**
 * Builds adapters from whichever keys are present. Every key is optional: Conduit reports missing
 * coverage rather than refusing to start.
 */
export function loadEnv(options: LoadOptions = {}): LoadedEnv {
  loadDotenv({ quiet: true });

  const adapters: ProviderAdapter[] = [];
  const missing: ProviderId[] = [];

  const extras = (provider: ProviderId) => ({
    ...(options.usage ? { usage: options.usage(provider) } : {}),
    ...(options.resolveFigi ? { resolveFigi: options.resolveFigi(provider) } : {}),
  });

  const polygonKey = process.env['POLYGON_API_KEY'];
  if (polygonKey) adapters.push(polygon({ apiKey: polygonKey, ...extras('polygon') }));
  else missing.push('polygon');

  const alpacaId = process.env['ALPACA_API_KEY_ID'];
  const alpacaSecret = process.env['ALPACA_API_SECRET_KEY'];
  if (alpacaId && alpacaSecret) {
    adapters.push(
      alpaca({
        keyId: alpacaId,
        secret: alpacaSecret,
        feed: (process.env['ALPACA_FEED'] as 'iex' | 'sip' | undefined) ?? 'iex',
        ...extras('alpaca'),
      }),
    );
  } else missing.push('alpaca');

  const databentoKey = process.env['DATABENTO_API_KEY'];
  const dataset = options.databentoDataset ?? process.env['DATABENTO_DATASET'];
  if (databentoKey && dataset) {
    adapters.push(
      databento({
        apiKey: databentoKey,
        dataset,
        ...(options.databentoAssetClasses ? { assetClasses: options.databentoAssetClasses } : {}),
        ...extras('databento'),
      }),
    );
  } else missing.push('databento');

  // Tiingo lands in Phase 3 of the provider table; the key is read so doctor can report it.
  if (!process.env['TIINGO_API_KEY']) missing.push('tiingo');

  return {
    adapters,
    missing,
    databaseUrl: process.env['DATABASE_URL'],
    openFigiKey: process.env['OPENFIGI_API_KEY'],
  };
}

/** Parses 7d, 24h, 30m, 90s into milliseconds. */
export function parseDuration(input: string): number {
  const match = /^(\d+)\s*([smhdw])$/.exec(input.trim().toLowerCase());
  if (!match) throw new Error(`cannot read "${input}" as a duration; try 7d, 24h, 30m, or 90s`);
  const value = Number(match[1]);
  const unit = match[2]!;
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]!;
  return value * multiplier;
}
