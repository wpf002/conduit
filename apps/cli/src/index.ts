#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import {
  SCHEMAS,
  isControl,
  nsToIso,
  redact,
  type MarketMessage,
  type ProviderId,
  type Schema,
} from '@conduit/core';
import { ConduitClient } from '@conduit/client';
import { MemoryLedgerStore, PrismaLedgerStore, UsageLedger, type LedgerStore } from '@conduit/ledger';
import {
  MemorySymbologyStore,
  OpenFigiClient,
  PrismaSymbologyStore,
  SymbologyResolver,
} from '@conduit/symbology';
import { loadEnv, parseDuration } from './env.js';
import { runDoctor } from './doctor.js';
import { money, ms, statusLabel, table } from './format.js';

const program = new Command();

program
  .name('conduit')
  .description('One interface over your own market data subscriptions')
  .version('0.0.0');

/**
 * Turns any failure into one line. Without this, a Prisma connection error prints its entire
 * bundled runtime to the terminal, and a provider error could print a URL containing a key.
 */
function fail(message: string, hint?: string): never {
  console.error(pc.red(redact(message)));
  if (hint) console.error(pc.dim(hint));
  process.exit(1);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // Prisma's initialization errors carry a multi-kilobyte message that starts with blank lines,
    // so take the first line that actually says something.
    const line = error.message
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return redact(line ?? error.name);
  }
  return String(error);
}

/** Postgres is optional everywhere; a command that needs durable data says so rather than failing. */
async function openLedgerStore(databaseUrl: string | undefined): Promise<{
  store: LedgerStore;
  durable: boolean;
  close: () => Promise<void>;
}> {
  if (!databaseUrl) {
    return { store: new MemoryLedgerStore(), durable: false, close: async () => {} };
  }
  const { createPrismaClient } = await import('@conduit/db');
  const db = createPrismaClient(databaseUrl);
  return {
    store: new PrismaLedgerStore(db),
    durable: true,
    close: () => db.$disconnect(),
  };
}

// ------------------------------------------------------------------------ doctor
program
  .command('doctor')
  .description('Validate every configured key and report coverage, latency, and quota headroom')
  .option('--symbols <list>', 'comma-separated probe symbols', 'AAPL')
  .option('--json', 'machine-readable output')
  .action(async (opts: { symbols: string; json?: boolean }) => {
    const env = loadEnv();
    const ledger = new UsageLedger({ store: new MemoryLedgerStore() });
    const adapters = env.adapters;

    if (adapters.length === 0) {
      console.error(pc.red('No provider keys configured. Fill .env — see .env.example.'));
      process.exitCode = 1;
      return;
    }

    const report = await runDoctor({
      adapters,
      ledger,
      missing: env.missing,
      probeSymbols: opts.symbols.split(',').map((s) => s.trim()),
    });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        table(
          ['provider', 'status', 'latency', 'schemas', 'detail'],
          report.checks.map((check) => [
            check.provider,
            statusLabel(check.status),
            ms(check.latencyMs),
            check.capabilities.join(','),
            check.detail,
          ]),
        ),
      );
      console.log();
      console.log(pc.bold('coverage'));
      for (const schema of SCHEMAS) {
        const providers = report.coverage[schema] ?? [];
        console.log(
          `  ${schema.padEnd(10)} ${providers.length > 0 ? providers.join(', ') : pc.yellow('none')}`,
        );
      }
      if (report.missing.length > 0) {
        console.log();
        console.log(pc.dim(`no key configured: ${report.missing.join(', ')}`));
      }
    }

    await Promise.all(adapters.map((a) => a.close()));
    await ledger.close();
    process.exitCode = report.ok ? 0 : 1;
  });

// ------------------------------------------------------------------------- spend
program
  .command('spend')
  .description('Usage and cost attribution from the local ledger')
  .option('--since <duration>', 'window, e.g. 7d or 24h', '7d')
  .option('--by <dimension>', 'provider | schema | symbol | kind', 'provider')
  .option('--json', 'machine-readable output')
  .action(async (opts: { since: string; by: string; json?: boolean }) => {
    const env = loadEnv();
    const dimension = opts.by as 'provider' | 'schema' | 'symbol' | 'kind';
    if (!['provider', 'schema', 'symbol', 'kind'].includes(dimension)) {
      console.error(pc.red(`--by must be provider, schema, symbol, or kind`));
      process.exitCode = 1;
      return;
    }

    const { store, durable, close } = await openLedgerStore(env.databaseUrl);
    if (!durable) {
      console.error(
        pc.yellow('DATABASE_URL is not set, so there is no stored usage to report. Run pnpm db:push.'),
      );
      process.exitCode = 1;
      await close();
      return;
    }

    const since = new Date(Date.now() - parseDuration(opts.since));
    let rows;
    try {
      rows = await store.spend(since, dimension);
    } catch (error) {
      await close();
      fail(
        `cannot read the usage ledger: ${describe(error)}`,
        'Check DATABASE_URL and that the schema exists (pnpm db:push).',
      );
    }

    if (opts.json) {
      console.log(JSON.stringify({ since: since.toISOString(), by: dimension, rows }, null, 2));
    } else if (rows.length === 0) {
      console.log(pc.dim(`no usage recorded since ${since.toISOString()}`));
    } else {
      console.log(
        table(
          [dimension, 'events', 'units', 'cost'],
          rows.map((row) => [
            row.key,
            String(row.events),
            String(row.units),
            money(row.costMicro),
          ]),
        ),
      );
      const total = rows.reduce((sum, row) => sum + row.costMicro, 0);
      console.log();
      console.log(`${pc.bold('total')} ${money(total)} since ${since.toISOString()}`);
      if (total === 0) {
        console.log(
          pc.dim('Cost is zero because the default model has no per-unit price. Override it in code.'),
        );
      }
    }
    await close();
  });

// ----------------------------------------------------------------------- resolve
program
  .command('resolve')
  .description('Resolve a symbol to a FIGI, as of a date')
  .argument('<symbol>', 'for example BRK.B')
  .option('--as-of <date>', 'ISO date; a past date is answered from the local cache only')
  .option('--provider <id>', 'interpret the symbol in this provider spelling')
  .option('--json', 'machine-readable output')
  .action(
    async (
      symbol: string,
      opts: { asOf?: string; provider?: string; json?: boolean },
    ) => {
      const env = loadEnv();
      let close = async () => {};
      let store;

      if (env.databaseUrl) {
        const { createPrismaClient } = await import('@conduit/db');
        const db = createPrismaClient(env.databaseUrl);
        store = new PrismaSymbologyStore(db);
        close = () => db.$disconnect();
      } else {
        store = new MemorySymbologyStore();
      }

      const resolver = new SymbologyResolver({
        store,
        openFigi: new OpenFigiClient(env.openFigiKey ? { apiKey: env.openFigiKey } : {}),
      });

      const asOf = opts.asOf ? new Date(opts.asOf) : undefined;
      if (opts.asOf && Number.isNaN(asOf!.getTime())) {
        console.error(pc.red(`cannot read "${opts.asOf}" as a date`));
        process.exitCode = 1;
        await close();
        return;
      }

      let instrument;
      try {
        instrument = await resolver.resolve(symbol, {
          ...(asOf ? { asOf } : {}),
          ...(opts.provider ? { provider: opts.provider as ProviderId } : {}),
        });
      } catch (error) {
        await close();
        fail(`resolution failed: ${describe(error)}`);
      }

      if (opts.json) {
        console.log(JSON.stringify({ symbol, asOf: asOf?.toISOString(), instrument }, null, 2));
      } else if (!instrument) {
        console.log(pc.yellow(`${symbol} did not resolve${asOf ? ` as of ${opts.asOf}` : ''}.`));
        if (asOf && resolver.stats().historicalRefusals > 0) {
          console.log(
            pc.dim(
              'A past date is answered from the local security master only: OpenFIGI answers as of\ntoday, and using that for a historical date returns the wrong instrument.',
            ),
          );
        }
        process.exitCode = 1;
      } else {
        console.log(
          table(
            ['figi', 'ticker', 'name', 'class', 'mic', 'active'],
            [
              [
                instrument.figi,
                instrument.ticker,
                instrument.name ?? '-',
                instrument.assetClass,
                instrument.exchangeMic ?? '-',
                String(instrument.active),
              ],
            ],
          ),
        );
      }
      await close();
    },
  );

// ------------------------------------------------------------------------ stream
program
  .command('stream')
  .description('Stream one schema for smoke testing')
  .argument('<symbols>', 'comma-separated symbols')
  .option('--schema <schema>', 'quote_l1 | trades | bars_1m | bars_1d | depth_10', 'quote_l1')
  .option('--limit <n>', 'stop after this many messages', '20')
  .action(async (symbolList: string, opts: { schema: string; limit: string }) => {
    const schema = opts.schema as Schema;
    if (!(SCHEMAS as readonly string[]).includes(schema)) {
      console.error(pc.red(`--schema must be one of ${SCHEMAS.join(', ')}`));
      process.exitCode = 1;
      return;
    }

    const env = loadEnv();
    if (env.adapters.length === 0) {
      console.error(pc.red('No provider keys configured. Fill .env — see .env.example.'));
      process.exitCode = 1;
      return;
    }

    const symbols = symbolList.split(',').map((s) => s.trim());
    const limit = Number(opts.limit);
    const client = new ConduitClient({
      providers: env.adapters,
      onEvent: (event) => console.error(pc.dim(`[${event.type}] ${event.provider}: ${event.reason}`)),
    });

    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());

    const sub = await client.subscribe({ symbols, schema, signal: controller.signal });
    console.error(pc.dim(`streaming ${schema} for ${symbols.join(', ')} from ${sub.activeProvider}`));

    let seen = 0;
    for await (const message of sub) {
      if (isControl(message)) {
        console.error(
          pc.yellow(`[switch] ${message.previousProvider} -> ${message.provider}: ${message.reason}`),
        );
        continue;
      }
      seen += 1;
      console.log(
        `${nsToIso(message.tsEvent)} ${message.provider.padEnd(9)} ${message.symbol.padEnd(8)} ${JSON.stringify(summarize(message))}`,
      );
      if (seen >= limit) break;
    }

    await client.close();
  });

function summarize(message: MarketMessage): Record<string, unknown> {
  switch (message.kind) {
    case 'quote':
      return { bid: message.bidPx, bidSz: message.bidSz, ask: message.askPx, askSz: message.askSz };
    case 'trade':
      return { px: message.px, sz: message.sz, flags: message.flags };
    case 'bar':
      return {
        o: message.open,
        h: message.high,
        l: message.low,
        c: message.close,
        v: message.volume,
      };
    case 'depth':
      return { bids: message.bids.length, asks: message.asks.length };
  }
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  fail(describe(error));
}
