# Migrating from a raw provider client

What replacing a hand-rolled Polygon or Alpaca integration actually involves. Written for the
Phase 5 migration of the first internal consumer, and the honest answer to "how long will this
take".

## What Conduit replaces

| You currently have | Conduit equivalent |
|---|---|
| A websocket client with reconnect logic | `ReconnectingSocket`, inside the adapter |
| Resubscribe-after-reconnect bookkeeping | `SubscriptionRegistry`, inside the adapter |
| A payload-to-your-types normalizer | the CDM, one shape across providers |
| `if (msg.ev === 'Q')` dispatch | `message.kind === 'quote'` |
| Millisecond timestamps, sometimes strings | `bigint` nanoseconds everywhere |
| Ad-hoc symbol spelling fixes | `@conduit/symbology` |
| Nothing, for a second provider | the failover router |

## What Conduit does not replace

- Order routing. Data only.
- Your strategy's own state machine.
- Condition-code and venue-identity handling. Those stay provider-specific and reach you through
  `message.raw` (see [cdm-draft.md](cdm-draft.md) rows 4 and 5).

## Migration, in order

### 1. Timestamps first, before touching anything else

This is the change that touches the most code and is the easiest to get subtly wrong. Conduit
timestamps are `bigint` nanoseconds. A comparison against a millisecond number silently produces
`false`, not a type error, if either side is `any`.

```ts
// Before
if (quote.t > lastSeen) { ... }            // milliseconds, number

// After
if (quote.tsEvent > lastSeenNs) { ... }    // nanoseconds, bigint
```

Convert at the edges, not in the middle: `nsToMs` for display and for comparing against
millisecond config, `msToNs` when an external system hands you milliseconds. Do not spread `Number()`
through the strategy.

### 2. Replace the message dispatch

```ts
// Before
socket.on('message', (raw) => {
  for (const msg of JSON.parse(raw)) {
    if (msg.ev === 'Q') onQuote(normalizeQuote(msg));
    if (msg.ev === 'T') onTrade(normalizeTrade(msg));
  }
});

// After
for await (const message of sub) {
  if (message.kind === 'control') { onProviderSwitch(message); continue; }
  if (message.kind === 'quote') onQuote(message);
  if (message.kind === 'trade') onTrade(message);
}
```

The control branch is new and it is not optional. A failover arrives on the same stream, and a
strategy that ignores it will not know why its provider field changed.

### 3. Delete the reconnect code

All of it, including the backoff, the resubscribe list, and the heartbeat timer. If a test covered
that code, the equivalent test in Conduit is `packages/providers/test/polygon-stream.test.ts`.

### 4. Quote sizes

Polygon and Alpaca report quote sizes in round lots; Conduit multiplies to shares by default. If
your code was already multiplying by 100, remove that. If it was not, your sizes were wrong before
and are right now, which will move any volume-conditioned logic.

### 5. Add the second provider last

Do not add failover in the same change as the migration. Get one provider working through Conduit,
confirm the strategy behaves identically, then add the second key and the router. Otherwise a
behaviour change and a failover event are indistinguishable in the logs.

### 6. Symbology only if you need it

If the consumer uses plain tickers and never asks a historical question, skip it. Wire it when you
hit a class share, or a backtest that spans a ticker change.

## Expected friction

| Thing | Why it bites |
|---|---|
| `bigint` arithmetic | mixing `bigint` and `number` throws at runtime, and `JSON.stringify` refuses `bigint` outright |
| `exactOptionalPropertyTypes` | `{ venue: undefined }` is not assignable where `venue?: string` is declared; omit the key |
| One-sided quotes | `bidPx` of 0 is normal at the open, and a naive spread calculation produces a nonsense number |
| `UNRESOLVED_FIGI` | `figi` is `''` until symbology is wired; keying a map on it collapses every instrument into one entry |

## Measuring it

Log your hours as you go, in [phase-5-dogfood.md](phase-5-dogfood.md). The comparison that decides
whether Conduit becomes a product is migration hours against the hours the original integration
took, and that number is only honest if it is written down while it hurts.
