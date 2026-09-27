/**
 * The wire protocol between Conduit and a non-TypeScript consumer.
 *
 * Newline-delimited JSON over stdin and stdout, with the consumer spawning this as a child process.
 * Not a socket and not a port: a subprocess has no listening surface to secure, dies with its parent,
 * and needs no cleanup. Market data goes provider → this process → the parent's pipe, all on one
 * machine, so nothing here changes the licensing position.
 *
 * Timestamps cross as decimal strings. JSON has no bigint, and a nanosecond epoch does not fit a
 * double — the same reason Databento's own encoder writes them as strings.
 */
export type RequestOp = 'summary' | 'snapshot' | 'subscribe' | 'unsubscribe' | 'health' | 'shutdown';

export interface Request {
  /** Echoed on every response. A subscribe's id is the handle used to unsubscribe. */
  readonly id: number;
  readonly op: RequestOp;
  readonly symbols?: readonly string[];
  readonly schema?: string;
  readonly assetClass?: string;
  /** Replay window, decimal-string nanoseconds. */
  readonly start?: string;
  readonly end?: string;
}

export type Response =
  /** Sent once at startup, after the providers are constructed. */
  | { readonly type: 'ready'; readonly providers: readonly string[]; readonly coverage: Record<string, readonly string[]> }
  /** A completed one-shot request. */
  | { readonly type: 'result'; readonly id: number; readonly data: unknown }
  /** One message on a subscription. */
  | { readonly type: 'message'; readonly id: number; readonly data: unknown }
  /** A subscription ended normally. */
  | { readonly type: 'end'; readonly id: number }
  | { readonly type: 'error'; readonly id: number; readonly code: string; readonly message: string };

/** Recursively converts bigints to decimal strings so JSON.stringify can handle a CDM message. */
export function encodeBigints(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(encodeBigints);
  if (value instanceof Set) return [...value].map(encodeBigints);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeBigints(v);
    return out;
  }
  return value;
}

export function parseRequest(line: string): Request | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: 'not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: 'not an object' };
  const record = parsed as Record<string, unknown>;
  if (typeof record['id'] !== 'number') return { error: 'id must be a number' };
  const op = record['op'];
  if (
    op !== 'summary' &&
    op !== 'snapshot' &&
    op !== 'subscribe' &&
    op !== 'unsubscribe' &&
    op !== 'health' &&
    op !== 'shutdown'
  ) {
    return { error: `unknown op: ${String(op)}` };
  }
  const symbols = record['symbols'];
  if (symbols !== undefined && (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string'))) {
    return { error: 'symbols must be an array of strings' };
  }
  return {
    id: record['id'],
    op,
    ...(symbols ? { symbols: symbols as string[] } : {}),
    ...(typeof record['schema'] === 'string' ? { schema: record['schema'] } : {}),
    ...(typeof record['assetClass'] === 'string' ? { assetClass: record['assetClass'] } : {}),
    ...(typeof record['start'] === 'string' ? { start: record['start'] } : {}),
    ...(typeof record['end'] === 'string' ? { end: record['end'] } : {}),
  };
}

/** Splits a byte stream into complete lines, holding a partial line until its newline arrives. */
export class LineReader {
  #pending = '';

  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines: string[] = [];
    let newline = this.#pending.indexOf('\n');
    while (newline !== -1) {
      lines.push(this.#pending.slice(0, newline));
      this.#pending = this.#pending.slice(newline + 1);
      newline = this.#pending.indexOf('\n');
    }
    return lines;
  }

  get buffered(): number {
    return this.#pending.length;
  }
}
