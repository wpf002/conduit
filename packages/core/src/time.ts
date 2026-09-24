/**
 * Timestamps are bigint nanoseconds everywhere. Nothing in Conduit degrades to Date or to
 * millisecond numbers, including at package boundaries and in the database.
 */
export const NS_PER_US = 1_000n;
export const NS_PER_MS = 1_000_000n;
export const NS_PER_SEC = 1_000_000_000n;

// Wall clock anchored once, advanced by a monotonic source. Two messages a microsecond apart
// keep their order even if the system clock steps.
const anchorWallNs = BigInt(Date.now()) * NS_PER_MS;
const anchorMonotonicNs = process.hrtime.bigint();

/** Conduit ingress timestamp. Monotonic within a process. */
export function nowNs(): bigint {
  return anchorWallNs + (process.hrtime.bigint() - anchorMonotonicNs);
}

export function msToNs(ms: number | bigint): bigint {
  return BigInt(ms) * NS_PER_MS;
}

export function usToNs(us: number | bigint): bigint {
  return BigInt(us) * NS_PER_US;
}

export function secToNs(sec: number | bigint): bigint {
  return BigInt(sec) * NS_PER_SEC;
}

/** Truncates. Only for display and for comparing against millisecond-resolution config. */
export function nsToMs(ns: bigint): number {
  return Number(ns / NS_PER_MS);
}

export function nsToDate(ns: bigint): Date {
  return new Date(nsToMs(ns));
}

export function dateToNs(date: Date): bigint {
  return msToNs(date.getTime());
}

const ISO_NS =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses an RFC-3339 timestamp without losing sub-millisecond digits. Date.parse truncates to
 * milliseconds, which would throw away the last six digits of an Alpaca timestamp.
 */
export function isoToNs(iso: string): bigint {
  const m = ISO_NS.exec(iso.trim());
  if (!m) throw new RangeError(`not an RFC-3339 timestamp: ${iso}`);
  const [, whole, fraction, zone] = m;
  const ms = Date.parse(`${whole}${zone ?? 'Z'}`);
  if (Number.isNaN(ms)) throw new RangeError(`not an RFC-3339 timestamp: ${iso}`);
  const fractionNs = fraction ? BigInt(fraction.padEnd(9, '0')) : 0n;
  return msToNs(ms) + fractionNs;
}

export function nsToIso(ns: bigint): string {
  const sec = ns / NS_PER_SEC;
  const frac = ns % NS_PER_SEC;
  const base = new Date(Number(sec) * 1000).toISOString().slice(0, 19);
  return `${base}.${frac.toString().padStart(9, '0')}Z`;
}

/** Age of a timestamp in milliseconds, for staleness checks against millisecond config. */
export function ageMs(tsNs: bigint, nowNsValue: bigint = nowNs()): number {
  return Number((nowNsValue - tsNs) / NS_PER_MS);
}
