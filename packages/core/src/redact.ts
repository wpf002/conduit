/**
 * Credentials never reach a log line, an error message, or a committed fixture. Adapters register
 * their secrets at construction; every error message and log line runs through redact().
 */
const secrets = new Set<string>();

/** Values shorter than this are too likely to collide with ordinary text to substitute blindly. */
const MIN_SECRET_LENGTH = 8;

export function registerSecret(value: string | undefined): void {
  if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  // Longest first, so a key that contains another registered value is masked whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/** Deep-redacts a value for logging. Objects are walked; nothing is mutated in place. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactValue) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out as T;
  }
  return value;
}

/** Test-only. Clearing the registry in production would unmask later log lines. */
export function clearSecrets(): void {
  secrets.clear();
}

export function secretCount(): number {
  return secrets.size;
}
