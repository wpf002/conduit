import type { ProviderId, Schema } from './ids.js';
import { redact, redactValue } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  readonly level: LogLevel;
  readonly msg: string;
  readonly provider?: ProviderId;
  readonly schema?: Schema;
  readonly symbol?: string;
  /** Anything else worth attaching. Values are redacted before the sink sees them. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * Where Conduit's diagnostics go. A single function so any logger adapts in one line:
 *
 *   const logger = (r) => pino[r.level]({ ...r.fields, provider: r.provider }, r.msg);
 *
 * The library is silent without one. It is a library, not an application, and writing to somebody
 * else's stdout uninvited is rude — but being silent meant diagnosing a live incident required
 * adding print statements to a dependency, which is worse.
 */
export type Logger = (record: LogRecord) => void;

export const NOOP_LOGGER: Logger = () => {};

export interface LoggerOptions {
  /** Records below this level are dropped before the sink is called. Default 'info'. */
  readonly level?: LogLevel;
}

/**
 * Wraps a sink with level filtering, credential redaction, and a guarantee it cannot throw into the
 * caller. Every adapter runs its logger through this, so a logger that throws, or a message that
 * happens to contain an API key, cannot take down a stream or leak.
 */
export function createLogger(sink: Logger | undefined, options: LoggerOptions = {}): Logger {
  if (!sink) return NOOP_LOGGER;
  const threshold = ORDER[options.level ?? 'info'];

  return (record) => {
    if (ORDER[record.level] < threshold) return;
    try {
      sink({
        ...record,
        msg: redact(record.msg),
        ...(record.fields ? { fields: redactValue(record.fields) } : {}),
      });
    } catch {
      /* diagnostics are never allowed to break the data path */
    }
  };
}

/** A logger for a CLI or a quick script. Writes one line per record to stderr. */
export function consoleLogger(options: LoggerOptions = {}): Logger {
  return createLogger((record) => {
    const parts = [record.level.toUpperCase(), record.provider ?? '-', record.msg];
    if (record.fields && Object.keys(record.fields).length > 0) {
      parts.push(JSON.stringify(record.fields));
    }
    process.stderr.write(`${parts.join(' ')}\n`);
  }, options);
}
