import type { Instrument } from '@conduit/core';
import type { SymbologyResolver } from './resolver.js';

export interface RefreshOptions {
  /** Instruments not re-resolved since this long ago are refreshed. Default 24 hours. */
  readonly maxAgeMs?: number;
  readonly limit?: number;
  readonly now?: () => Date;
  readonly onChange?: (change: RefreshChange) => void;
}

export type RefreshChange =
  | {
      readonly kind: 'ticker_changed';
      readonly figi: string;
      readonly from: string;
      readonly to: string;
    }
  | { readonly kind: 'delisted'; readonly figi: string; readonly ticker: string }
  | { readonly kind: 'unchanged'; readonly figi: string };

export interface RefreshReport {
  readonly examined: number;
  readonly tickerChanges: number;
  readonly delistings: number;
  readonly failures: number;
}

/**
 * The nightly job. Re-resolves stale instruments by FIGI and, when a ticker has moved, closes the
 * old mapping's validity window and opens a new one instead of overwriting.
 *
 * Closing rather than overwriting is the whole point. A backtest that asks what FB meant in 2021
 * has to get the pre-rename mapping, not today's answer, and a ticker that has been reassigned to
 * a different company has to resolve to whichever company held it on the query date.
 */
export async function refreshSecurityMaster(
  resolver: SymbologyResolver,
  options: RefreshOptions = {},
): Promise<RefreshReport> {
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? 86_400_000;
  const limit = options.limit ?? 500;
  const before = new Date(now().getTime() - maxAgeMs);

  const stale = await resolver.store.staleInstruments(before, limit);
  let tickerChanges = 0;
  let delistings = 0;
  let failures = 0;

  for (const instrument of stale) {
    try {
      // By FIGI, not by ticker: the FIGI is the stable identity, the ticker is what moves.
      const current = await resolver.resolveByFigi(instrument.figi, instrument.assetClass);

      if (!current) {
        await closeOpenMappings(resolver, instrument, now());
        await resolver.store.setActive(instrument.figi, false);
        delistings += 1;
        options.onChange?.({ kind: 'delisted', figi: instrument.figi, ticker: instrument.ticker });
        continue;
      }

      if (current.ticker !== instrument.ticker) {
        await closeOpenMappings(resolver, instrument, now());
        // The new spelling's window opens where the old one closed, so there is no gap and no
        // overlap: every date resolves to exactly one instrument.
        await resolver.recordMapping({ ...current, figi: instrument.figi }, current.ticker, now());
        tickerChanges += 1;
        options.onChange?.({
          kind: 'ticker_changed',
          figi: instrument.figi,
          from: instrument.ticker,
          to: current.ticker,
        });
      } else {
        options.onChange?.({ kind: 'unchanged', figi: instrument.figi });
      }

      await resolver.store.markResolved(instrument.figi, now());
    } catch {
      failures += 1;
    }
  }

  return { examined: stale.length, tickerChanges, delistings, failures };
}

async function closeOpenMappings(
  resolver: SymbologyResolver,
  instrument: Instrument,
  at: Date,
): Promise<void> {
  for (const mapping of await resolver.store.mappingsFor(instrument.figi)) {
    if (mapping.validTo === null) {
      await resolver.store.closeMapping(instrument.figi, mapping.provider, mapping.symbol, at);
    }
  }
}
