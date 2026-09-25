import { request } from 'undici';
import {
  AuthError,
  CdmFlags,
  RateLimitError,
  TransportError,
  redact,
  type ProviderId,
} from '@conduit/core';
import { parseJsonLossless } from './json.js';
import { registerConditionFlags } from './conditions.js';
import { registerVenueLabels } from './venues.js';

/**
 * Both vendors serve their venue and condition tables from authenticated reference endpoints, which
 * is why this package ships none of them. These loaders fetch them with the user's own key and
 * populate the registries, so the tables come from the vendor rather than from anybody's memory.
 *
 * One call each, at startup. `conduit doctor` does it for you.
 */
export interface ReferenceTable {
  /** Vendor code to whatever label the vendor gave it: a MIC from Massive, a name from Alpaca. */
  readonly labels: Readonly<Record<string, string>>;
  readonly count: number;
}

export interface ConditionTable {
  /** Vendor code to the vendor's own name for the condition. */
  readonly names: Readonly<Record<string, string>>;
  /** Vendor code to CDM flags, inferred from those names by `flagsFromConditionName`. */
  readonly flags: Readonly<Record<string, number>>;
  readonly count: number;
}

async function getJson(
  url: URL,
  headers: Record<string, string>,
  provider: ProviderId,
): Promise<unknown> {
  let res;
  try {
    res = await request(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
  } catch (error) {
    throw new TransportError(
      `${provider} reference request failed: ${redact(error instanceof Error ? error.message : String(error))}`,
      { provider, cause: error },
    );
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new AuthError(`${provider} rejected the key on a reference request`, { provider });
  }
  if (res.statusCode === 429) {
    throw new RateLimitError(`${provider} rate limited a reference request`, { provider });
  }
  if (res.statusCode >= 400) {
    throw new TransportError(`${provider} reference HTTP ${res.statusCode}`, { provider });
  }
  return parseJsonLossless(await res.body.text());
}

/**
 * Massive's exchange table. `mic` is the real MIC; `operating_mic` is the parent, used only when a
 * venue has no MIC of its own. An entry with neither is skipped rather than guessed at.
 */
export async function fetchPolygonExchanges(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly assetClass?: string;
}): Promise<ReferenceTable> {
  const url = new URL('/v3/reference/exchanges', options.baseUrl ?? 'https://api.polygon.io');
  url.searchParams.set('asset_class', options.assetClass ?? 'stocks');
  url.searchParams.set('locale', 'us');

  const body = (await getJson(url, { Authorization: `Bearer ${options.apiKey}` }, 'polygon')) as {
    results?: { id?: unknown; mic?: unknown; operating_mic?: unknown; name?: unknown }[];
  };

  const labels: Record<string, string> = {};
  for (const entry of body.results ?? []) {
    if (typeof entry.id !== 'number') continue;
    const label =
      typeof entry.mic === 'string' && entry.mic.length > 0
        ? entry.mic
        : typeof entry.operating_mic === 'string' && entry.operating_mic.length > 0
          ? entry.operating_mic
          : undefined;
    if (label) labels[String(entry.id)] = label;
  }
  return { labels, count: Object.keys(labels).length };
}

/**
 * Infers CDM flags from a condition's own name. The CDM only models semantics that exist across all
 * three vendors (see @conduit/core CdmFlags), and the vendors agree on names far better than on
 * codes, so matching on the name is more honest than a hand-keyed id table.
 *
 * Returns 0 for anything it does not recognise, which is most conditions. Override by registering
 * your own map afterwards.
 */
export function flagsFromConditionName(name: string): number {
  const n = name.toLowerCase();
  let flags = 0;
  if (n.includes('odd lot')) flags |= CdmFlags.OddLot;
  if (
    n.includes('out of sequence') ||
    n.includes('sold last') ||
    n.includes('average price') ||
    n.includes('prior reference price') ||
    n.includes('cash sale') ||
    n.includes('next day')
  ) {
    flags |= CdmFlags.OutOfSequence;
  }
  if (n.includes('form t') || n.includes('extended hours') || n.includes('derivatively priced')) {
    flags |= CdmFlags.TradeThroughExempt;
  }
  if (n.includes('halt') || n.includes('trading range indication')) flags |= CdmFlags.Halted;
  if (n.includes('correct') || n.includes('cancel')) flags |= CdmFlags.Correction;
  return flags;
}

export async function fetchPolygonConditions(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly assetClass?: string;
}): Promise<ConditionTable> {
  const url = new URL('/v3/reference/conditions', options.baseUrl ?? 'https://api.polygon.io');
  url.searchParams.set('asset_class', options.assetClass ?? 'stocks');
  url.searchParams.set('limit', '1000');

  const body = (await getJson(url, { Authorization: `Bearer ${options.apiKey}` }, 'polygon')) as {
    results?: { id?: unknown; name?: unknown }[];
  };

  const names: Record<string, string> = {};
  const flags: Record<string, number> = {};
  for (const entry of body.results ?? []) {
    if (typeof entry.id !== 'number' || typeof entry.name !== 'string') continue;
    names[String(entry.id)] = entry.name;
    const inferred = flagsFromConditionName(entry.name);
    if (inferred !== 0) flags[String(entry.id)] = inferred;
  }
  return { names, flags, count: Object.keys(names).length };
}

function alpacaHeaders(keyId: string, secret: string): Record<string, string> {
  return { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret };
}

/** Alpaca returns code-to-name, not MICs, so the registered label is the exchange's name. */
export async function fetchAlpacaExchanges(options: {
  readonly keyId: string;
  readonly secret: string;
  readonly baseUrl?: string;
}): Promise<ReferenceTable> {
  const url = new URL('/v2/stocks/meta/exchanges', options.baseUrl ?? 'https://data.alpaca.markets');
  const body = (await getJson(
    url,
    alpacaHeaders(options.keyId, options.secret),
    'alpaca',
  )) as Record<string, unknown>;

  const labels: Record<string, string> = {};
  for (const [code, name] of Object.entries(body)) {
    if (typeof name === 'string' && name.length > 0) labels[code] = name;
  }
  return { labels, count: Object.keys(labels).length };
}

export async function fetchAlpacaConditions(options: {
  readonly keyId: string;
  readonly secret: string;
  readonly baseUrl?: string;
  /** 'trade' or 'quote'. Alpaca keys its table by tick type and tape. */
  readonly tickType?: 'trade' | 'quote';
  readonly tape?: 'A' | 'B' | 'C';
}): Promise<ConditionTable> {
  const url = new URL(
    `/v2/stocks/meta/conditions/${options.tickType ?? 'trade'}`,
    options.baseUrl ?? 'https://data.alpaca.markets',
  );
  url.searchParams.set('tape', options.tape ?? 'C');

  const body = (await getJson(
    url,
    alpacaHeaders(options.keyId, options.secret),
    'alpaca',
  )) as Record<string, unknown>;

  const names: Record<string, string> = {};
  const flags: Record<string, number> = {};
  for (const [code, name] of Object.entries(body)) {
    if (typeof name !== 'string' || name.length === 0) continue;
    names[code] = name;
    const inferred = flagsFromConditionName(name);
    if (inferred !== 0) flags[code] = inferred;
  }
  return { names, flags, count: Object.keys(names).length };
}

export interface LoadedReference {
  readonly provider: ProviderId;
  readonly venues: number;
  readonly conditions: number;
  /** Conditions whose name matched a CDM flag. The rest are recognised but carry no flag. */
  readonly conditionsFlagged: number;
}

/** Fetches and registers both tables for Massive. */
export async function loadPolygonReference(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
}): Promise<LoadedReference> {
  const [venues, conditions] = await Promise.all([
    fetchPolygonExchanges(options),
    fetchPolygonConditions(options),
  ]);
  registerVenueLabels('polygon', venues.labels);
  registerConditionFlags('polygon', conditions.flags);
  return {
    provider: 'polygon',
    venues: venues.count,
    conditions: conditions.count,
    conditionsFlagged: Object.keys(conditions.flags).length,
  };
}

/** Fetches and registers both tables for Alpaca. */
export async function loadAlpacaReference(options: {
  readonly keyId: string;
  readonly secret: string;
  readonly baseUrl?: string;
  readonly tape?: 'A' | 'B' | 'C';
}): Promise<LoadedReference> {
  const [venues, conditions] = await Promise.all([
    fetchAlpacaExchanges(options),
    fetchAlpacaConditions(options),
  ]);
  registerVenueLabels('alpaca', venues.labels);
  registerConditionFlags('alpaca', conditions.flags);
  return {
    provider: 'alpaca',
    venues: venues.count,
    conditions: conditions.count,
    conditionsFlagged: Object.keys(conditions.flags).length,
  };
}
