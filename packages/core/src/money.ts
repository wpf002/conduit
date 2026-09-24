/** Cost is integer micro-units of the account currency. No floats anywhere in the cost path. */
export type Micros = number & { readonly __brand: 'Micros' };

export const ZERO_MICROS = 0 as Micros;

export function micros(value: number): Micros {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`micro-units must be a safe integer, got ${value}`);
  }
  return value as Micros;
}

export function addMicros(a: Micros, b: Micros): Micros {
  return micros(a + b);
}

export function sumMicros(values: readonly Micros[]): Micros {
  let total = 0;
  for (const v of values) total += v;
  return micros(total);
}

export function centsToMicros(cents: number): Micros {
  return micros(Math.round(cents) * 10_000);
}

/** Rounds half up. Only for display. */
export function microsToCents(value: Micros): number {
  return Math.round(value / 10_000);
}

export function formatMicros(value: Micros, currency = 'USD'): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 1_000_000);
  const frac = (abs % 1_000_000).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${sign}${whole}.${frac} ${currency}`;
}
