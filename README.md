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

for await (const quote of sub) {
  console.log(quote.figi, quote.bidPx, quote.askPx, quote.tsEvent);
}
```

## Supported providers

| Provider   | Quotes | Trades | Bars | Depth | Status |
|------------|--------|--------|------|-------|--------|
| Polygon    | ✅     | ✅     | ✅   | ⏳    | Phase 1 |
| Alpaca     | ✅     | ✅     | ✅   | —     | Phase 2 |
| Databento  | ✅     | ✅     | ✅   | ✅    | Phase 2 |
| Tiingo     | —      | —      | ✅   | —     | Phase 3 |

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

## Environment

See `.env.example`. Every provider key is optional — Conduit works with whichever subset you
have, and reports missing coverage rather than failing.

## License

Unlicensed / all rights reserved (pending Phase 5 decision).
