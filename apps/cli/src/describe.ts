import { redact } from '@conduit/core';

/**
 * A one-line error for the terminal, keeping the part that says what went wrong.
 *
 * Prisma's errors are the reason this is not just `error.message`. They arrive as several kilobytes
 * beginning with blank lines and an invocation header, with the actual cause further down:
 *
 *     (blank)
 *     Invalid `prisma.symbolMap.findMany()` invocation:
 *     (blank)
 *     (blank)
 *     Database `conduit` does not exist on the database server
 *
 * Taking the first non-empty line — which this did — printed the header and threw the cause away, so
 * `conduit resolve AAPL` against a missing database reported
 * "Invalid `prisma.symbolMap.findMany()` invocation:" and nothing else. A header ending in a colon is
 * a label for what follows, so when one is found the line that follows is what the reader needs.
 */
export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const lines = error.message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const first = lines[0];
  if (first === undefined) return redact(error.name);

  const last = lines[lines.length - 1];
  if (first.endsWith(':') && last !== undefined && last !== first) {
    return redact(`${first} ${last}`);
  }
  return redact(first);
}
