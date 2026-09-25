import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCUMENTED_ALPACA_VENUES,
  DOCUMENTED_POLYGON_VENUES,
  clearVenueMaps,
  micFor,
  registerVenueMap,
  venueCode,
} from '../src/venues.js';

afterEach(clearVenueMaps);

describe('venueCode', () => {
  it('stringifies a numeric code and passes a character code through', () => {
    expect(venueCode(62)).toBe('62');
    expect(venueCode('V')).toBe('V');
  });

  it('is undefined rather than a guess when the field is absent or unusable', () => {
    expect(venueCode(undefined)).toBeUndefined();
    expect(venueCode('')).toBeUndefined();
    expect(venueCode(Number.NaN)).toBeUndefined();
    expect(venueCode(null)).toBeUndefined();
  });
});

describe('micFor', () => {
  it('resolves nothing until a map is registered', () => {
    expect(micFor('polygon', '62')).toBeUndefined();
  });

  it('resolves from a map the consumer supplied', () => {
    registerVenueMap('polygon', { 62: 'FINR', 11: 'XBOS' });
    expect(micFor('polygon', 62)).toBe('FINR');
    expect(micFor('polygon', '11')).toBe('XBOS');
    // A code the map does not cover stays undefined.
    expect(micFor('polygon', '999')).toBeUndefined();
    // And registering for one provider does not answer for another.
    expect(micFor('alpaca', '62')).toBeUndefined();
  });

  it('merges successive registrations instead of replacing', () => {
    registerVenueMap('alpaca', { A: 'XASE' });
    registerVenueMap('alpaca', { B: 'XBOS' });
    expect(micFor('alpaca', 'A')).toBe('XASE');
    expect(micFor('alpaca', 'B')).toBe('XBOS');
  });
});

describe('documented venue names', () => {
  it('records only what the vendors publish outside an authenticated endpoint', () => {
    // Massive's trade docs name exactly one id: 62 is the FINRA ORF, not MEMX as an earlier
    // hand-written table in this repo claimed.
    expect(DOCUMENTED_POLYGON_VENUES['62']).toBe('FINRA ORF');
    expect(Object.keys(DOCUMENTED_POLYGON_VENUES)).toHaveLength(1);
    expect(DOCUMENTED_ALPACA_VENUES['V']).toBe('IEX');
  });
});
