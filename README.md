# Conduit

One interface over your own market data subscriptions. Bring your own provider keys; Conduit
handles normalization, failover, quota accounting, and symbology.

## Why

Running a strategy against US equities, options, and futures usually means three vendors, three
auth schemes, three symbol conventions, and three reconnect implementations. Conduit collapses
that into one client without changing who you pay or what you're licensed for.

## Design constraint

Market data flows **provider → your process**. Conduit never proxies ticks through
infrastructure we operate. Your provider agreements are unaffected because no redistribution
occurs. Any hosted component is metadata-only.

## Install

```bash
pnpm add @conduit/client @conduit/providers
```

## Quickstart

```ts
import { ConduitClient } from '@conduit/client';
import { polygon, alpaca } from '@conduit/providers';

const conduit = new ConduitClient({
  providers: [
    polygon({ apiKey: process.env.POLYGON_API_KEY! }),
    alpaca({ keyId: process.env.ALPACA_API_KEY_ID!, secret: process.env.ALPACA_API_SECRET_KEY! }),
  ],
  failover: { strategy: 'ordered', healthWindowMs: 30_000 },
});

const sub = await conduit.subscribe({
  symbols: ['AAPL', 'BRK.B'],
  schema: 'quote_l1',
});

for await (const message of sub) {
  // Failovers are announced on the same stream, ahead of the data they explain.
  if (message.kind === 'control') {
    console.warn(message.control, message.previousProvider, '->', message.provider, message.reason);
    continue;
  }
  console.log(message.symbol, message.bidPx, message.askPx, message.tsEvent);
}
```

## Supported providers

| Provider   | Quotes | Trades | Bars    | Depth | Live | Replay | Status |
|------------|--------|--------|---------|-------|------|--------|--------|
| Polygon    | ✅     | ✅     | 1m      | —     | ✅   | —      | Phase 1 |
| Alpaca     | ✅     | ✅     | 1m, 1d  | —     | ✅   | —      | Phase 2 |
| Databento  | ✅     | ✅     | 1m, 1d  | ✅    | —    | ✅     | Phase 2 |
| Tiingo     | —      | —      | 1d      | —     | —    | ✅     | Phase 3 |

Databento is replay-only: its live feed is binary DBN over a raw TCP gateway, which is a different
transport from everything else here. See [docs/databento-live.md](docs/databento-live.md).

## Packages

| Package | Purpose |
|---|---|
| `@conduit/core` | Common Data Model, provider interface, error taxonomy |
| `@conduit/providers` | Provider adapters |
| `@conduit/symbology` | FIGI resolution and local security master |
| `@conduit/ledger` | Quota accounting and spend attribution |
| `@conduit/client` | Failover router and subscription manager |
| `@conduit/cli` | `conduit doctor`, `conduit spend`, `conduit resolve` |

## CLI

```bash
conduit doctor                              # validate every key, report coverage and headroom
conduit spend --since 7d --by provider      # usage and cost from the local ledger
conduit resolve BRK.B --as-of 2019-01-01    # symbol to FIGI, as of a date
conduit stream AAPL,MSFT --schema quote_l1  # smoke test one schema
```

`doctor` is the one you'll run most. It distinguishes the three failures that look alike from the
outside:

| Report | Means |
|---|---|
| `auth failed` | the key is dead; the provider is dropped from coverage |
| `no entitlement` | the key works for equities and was refused for options or futures |
| `near ceiling` | the key works and is close to its window limit |

Every command takes `--json`.

## Usage accounting

`@conduit/ledger` counts REST calls, websocket subscriptions, and messages per provider per window,
and refuses locally before a provider answers 429 — a refusal costs one call, a 429 mid-session
costs a reconnect and a gap.

```ts
const ledger = new UsageLedger({ store: new PrismaLedgerStore(db) });
polygon({ apiKey, usage: ledger.hooksFor('polygon') });
```

Cost is integer micro-units and the default per-unit price is **zero** for every provider. A
flat-rate plan genuinely costs nothing per message, and a made-up number would show up in a spend
report as if it were real. Supply your own model to attribute spend:

```ts
new UsageLedger({ costModel: { perUnit: { polygon: { rest: 2_000 } } } });
```

Ledger data is written to the user's local Postgres and never transmitted.

## Status

| Phase | State |
|---|---|
| 0 — falsify before building | gate 1 closed on published terms (emails not being sent); CDM rows 1, 2, 5, 7 resolved |
| 1 — core + Polygon | done |
| 2 — Alpaca, Databento, failover router | done; Databento is replay-only |
| 3 — symbology | done |
| 4 — ledger + CLI | done |
| 5 — dogfood in the internal consumers | not started; measurement apparatus built |
| 6 — optional public release | gated on Phase 5 |

Phase 5 is the go/no-go gate for product-ization, and three of its four outcomes end with Conduit
staying an internal package. See [docs/phase-5-dogfood.md](docs/phase-5-dogfood.md) and
[docs/migration.md](docs/migration.md).

## Branch protection

`main` requires the `ci` check and blocks force pushes. To reapply it, send a JSON body — the
shorthand form sends `strict` as a string and the API rejects it:

```bash
gh api -X PUT repos/wpf002/conduit/branches/main/protection --input - << 'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["ci"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

## Toolchain

Two dependencies are deliberately held back from `latest`, and `pnpm up --latest` will try to move
both:

| Package | Pinned | Why |
|---|---|---|
| `typescript` | `^5.9.3` | `tsup` bundles `rollup-plugin-dts@6.1.1`, built against the TS 5.7 API. TS 7 removed `useCaseSensitiveFileNames`, so `--dts` builds crash. |
| `prisma`, `@prisma/client` | `7.10.0` | npm's `latest` tag is an 8.0 release candidate whose rewritten CLI has no `generate` command. |
| `@types/node` | `^22` | Matches `engines: node >=22` and the CI runner. Types ahead of the minimum runtime let code compile that does not run. |

## Development

```bash
pnpm install
cp .env.example .env    # fill in your provider keys
pnpm db:push            # local Postgres for symbology cache
pnpm build
pnpm test
```

## Failover

The router does three things, in this order:

1. **Coverage.** Which of your configured keys can serve this symbol, schema, and asset class at
   all. A gap is reported as a `CoverageError` naming what you have configured.
2. **Health.** Consecutive failures, message staleness, and rate-limit responses mark a provider
   degraded; the subscription moves to the next covering provider and fails back when the first one
   recovers.
3. **Order.** On a switch, sequence continuity beats completeness. A provider that replays history
   as it comes up has that history dropped, per symbol, against the last timestamp the consumer
   already saw. `subscription.droppedOutOfOrder` counts it.

It is explicitly not cost minimization. Cost routing only paid off under subscription pooling, and
pooling is the part the licences prohibit.

## Reference data

Neither Massive nor Alpaca publishes its venue or condition-code table outside an authenticated
endpoint, so Conduit ships **neither**. An earlier version of this repo shipped hand-written ones;
they were wrong, and a wrong venue or condition flag is worse than an absent one because a strategy
filtering on it acts silently.

`conduit doctor` pulls both tables with your own key and registers them:

```bash
conduit doctor                  # loads venue + condition tables, reports the counts
conduit doctor --no-reference   # skip it
```

In code:

```ts
import { loadPolygonReference, venueLabelFor } from '@conduit/providers';

await loadPolygonReference({ apiKey });
venueLabelFor('polygon', 62); // 'FINR', from Massive's own table
```

Until a table is registered, `venue` carries the vendor's own code verbatim and condition flags are
empty apart from odd-lot, which is derived from size and marked `Derived`.

## Symbology

FIGI is the internal primary key. Every provider symbol is an alias with a validity window, which
is what makes a historical query answerable:

```ts
const resolver = new SymbologyResolver({
  store: new PrismaSymbologyStore(db),
  openFigi: new OpenFigiClient({ apiKey: process.env.OPENFIGI_API_KEY }),
});

// Adapters take a synchronous hook that only reads the in-process cache.
await resolver.prime(['AAPL', 'BRK.B']);
polygon({ apiKey, resolveFigi: resolver.hookFor('polygon') });

// A ticker means different things at different times.
await resolver.resolve('CBRE', { asOf: new Date('1999-03-01') }); // the first company
await resolver.resolve('CBRE', { asOf: new Date('2024-06-03') }); // the current one
```

Ticker reuse after a delisting is the specific failure that silently corrupts a backtest, so a
query with a past `asOf` is answered from the local security master only. OpenFIGI answers as of
today, and using today's answer for a 2019 question is how the wrong instrument gets into a
result set.

Postgres is optional. `MemorySymbologyStore` implements the same interface for a process that does
not want a database.

## Streamable schemas

`capabilities` on an adapter lists what it can serve on `stream()`, not what the vendor sells.
Polygon has no daily-aggregate websocket channel and no L2 entitlement on the plans Conduit has
been tested against, so `bars_1d` and `depth_10` throw `CoverageError` there rather than returning
an empty iterator.

## Environment

See `.env.example`. Every provider key is optional — Conduit works with whichever subset you
have, and reports missing coverage rather than failing.

## License

Unlicensed / all rights reserved (pending Phase 5 decision).
