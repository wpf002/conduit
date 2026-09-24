import { NS_PER_MS, NS_PER_SEC, NS_PER_US, SchemaError, type ProviderId } from '@conduit/core';

/**
 * Vendors mix timestamp units across endpoints — Polygon's websocket quotes are milliseconds
 * while its v2 snapshot endpoint returns nanoseconds for the same field name. Inferring from
 * magnitude is more reliable than tracking which endpoint returns which unit.
 *
 * Boundaries assume a timestamp after 2001 and before the year 2255, which holds for every market
 * data timestamp Conduit will ever see.
 *
 * A string is parsed as a BigInt directly. Going through Number first would defeat the lossless
 * JSON parse in json.ts that produced the string in the first place.
 */
export function coerceEpochNs(
  value: number | string | bigint,
  provider?: ProviderId,
  field = 'timestamp',
): bigint {
  const where = provider ? { provider, field } : { field };
  let n: bigint;
  try {
    if (typeof value === 'bigint') n = value;
    else if (typeof value === 'string') n = BigInt(value.trim());
    else if (Number.isFinite(value)) n = BigInt(Math.trunc(value));
    else throw new RangeError(`not a finite number: ${value}`);
  } catch (error) {
    throw new SchemaError(`cannot read ${field} as an epoch: ${String(value)}`, {
      ...where,
      cause: error,
    });
  }

  if (n <= 0n) throw new SchemaError(`${field} must be positive, got ${value}`, where);
  if (n < 100_000_000_000n) return n * NS_PER_SEC; // < 1e11  -> seconds
  if (n < 100_000_000_000_000n) return n * NS_PER_MS; // < 1e14 -> milliseconds
  if (n < 100_000_000_000_000_000n) return n * NS_PER_US; // < 1e17 -> microseconds
  return n; // nanoseconds
}
