import type { ProviderId } from '@conduit/core';

/**
 * Venue identity has no shared vocabulary across vendors (docs/cdm-draft.md row 5), and the
 * per-vendor code tables are not publicly documented — both Massive and Alpaca serve theirs from an
 * authenticated reference endpoint.
 *
 * So the CDM carries each vendor's own code **verbatim** as a string, and does not pretend it is a
 * MIC. An earlier version of this file shipped a hand-written numeric-id-to-MIC table for Massive;
 * it was wrong (it mapped id 62 to MEMX, when Massive's own trade documentation says 62 is the FINRA
 * ORF), and being wrong about a venue is worse than leaving it untranslated.
 *
 * Consumers that need MICs register a map they trust, from the vendor's reference endpoint:
 *
 *   registerVenueMap('polygon', await fetchPolygonExchanges(apiKey));
 *   micFor('polygon', '62');  // -> whatever that map says
 */
const maps = new Map<ProviderId, Map<string, string>>();

/** The only Massive exchange id documented outside the authenticated reference endpoint. */
export const DOCUMENTED_POLYGON_VENUES: Readonly<Record<string, string>> = {
  // "Omitted on OTC trades reported through the FINRA ORF (exchange 62)" — stocks trade docs.
  62: 'FINRA ORF',
};

/** Codes Alpaca's public documentation names directly. */
export const DOCUMENTED_ALPACA_VENUES: Readonly<Record<string, string>> = {
  A: 'NYSE American (AMEX)',
  B: 'Nasdaq OMX BX',
  V: 'IEX',
};

export function registerVenueMap(
  provider: ProviderId,
  entries: Readonly<Record<string, string>>,
): void {
  const map = maps.get(provider) ?? new Map<string, string>();
  for (const [code, mic] of Object.entries(entries)) map.set(String(code), mic);
  maps.set(provider, map);
}

/** Whatever the registered map says for this code, or undefined. Never a guess. */
export function micFor(provider: ProviderId, code: string | number | undefined): string | undefined {
  if (code === undefined) return undefined;
  return maps.get(provider)?.get(String(code));
}

export function clearVenueMaps(): void {
  maps.clear();
}

/**
 * The vendor's own venue code as a string, for the CDM `venue` field. No translation, so nothing
 * here can be wrong — a consumer comparing codes across providers is doing so knowingly.
 */
export function venueCode(code: unknown): string | undefined {
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  if (typeof code === 'string' && code.length > 0) return code;
  return undefined;
}
