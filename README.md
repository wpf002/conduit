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
