import { describe, expect, it } from 'vitest';
import { ageMs, dateToNs, isoToNs, msToNs, nowNs, nsToIso, nsToMs, secToNs } from '../src/time.js';

describe('isoToNs', () => {
  it('keeps all nine fractional digits', () => {
    // Date.parse would truncate this to 14:30:00.123, losing 456789ns.
    expect(isoToNs('2024-01-02T14:30:00.123456789Z')).toBe(1704205800123456789n);
  });

  it('pads short fractions instead of misreading them', () => {
    expect(isoToNs('2024-01-02T14:30:00.5Z')).toBe(1704205800500000000n);
    expect(isoToNs('2024-01-02T14:30:00.000001Z')).toBe(1704205800000001000n);
  });

  it('handles a missing fraction and a numeric offset', () => {
    expect(isoToNs('2024-01-02T14:30:00Z')).toBe(1704205800000000000n);
    expect(isoToNs('2024-01-02T09:30:00-05:00')).toBe(1704205800000000000n);
  });

  it('rejects anything that is not RFC-3339', () => {
    expect(() => isoToNs('1704205800')).toThrow(RangeError);
    expect(() => isoToNs('')).toThrow(RangeError);
  });

  it('round-trips through nsToIso', () => {
    const iso = '2024-06-28T18:04:05.987654321Z';
    expect(nsToIso(isoToNs(iso))).toBe(iso);
  });
});

describe('unit conversion', () => {
  it('scales without floating point', () => {
    expect(msToNs(1_700_000_000_000)).toBe(1_700_000_000_000_000_000n);
    expect(secToNs(1)).toBe(1_000_000_000n);
    expect(nsToMs(1_700_000_000_123_456_789n)).toBe(1_700_000_000_123);
  });

  it('accepts a Date only at the boundary', () => {
    const d = new Date('2024-01-02T14:30:00.000Z');
    expect(dateToNs(d)).toBe(1704205800000000000n);
  });
});

describe('nowNs', () => {
  it('is monotonic across successive calls', () => {
    const samples = Array.from({ length: 1000 }, () => nowNs());
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });

  it('is within a second of wall clock', () => {
    expect(Math.abs(nsToMs(nowNs()) - Date.now())).toBeLessThan(1000);
  });

  it('measures age in milliseconds', () => {
    expect(ageMs(nowNs() - 5_000_000_000n)).toBeGreaterThanOrEqual(4999);
  });
});
