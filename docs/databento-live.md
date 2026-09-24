# Databento: why the adapter is historical-only

## What is implemented

`databento({ apiKey, dataset })` covers the historical HTTP API: `quote_l1` (mbp-1), `trades`,
`bars_1m` (ohlcv-1m), `bars_1d` (ohlcv-1d), and `depth_10` (mbp-10). It is the only adapter in
Conduit that serves ten-level depth.

`stream()` requires a replay window:

```ts
const sub = await conduit.subscribe({
  symbols: ['ESZ4'],
  schema: 'depth_10',
  assetClass: 'future',
  start: dateToNs(new Date('2024-01-02T14:30:00Z')),
  end: dateToNs(new Date('2024-01-02T21:00:00Z')),
});
```

Without `start` it throws `CoverageError`. `snapshot()` also throws `CoverageError`: the historical
API has no point-in-time endpoint, every query is a range, and returning the last record of an
arbitrary lookback window would be a guess dressed up as a quote.

## What is not implemented, and why

Databento's live feed is not HTTP or websocket. It is length-delimited binary DBN over a raw TCP
gateway, with a CRAM handshake: the gateway sends a challenge, the client answers with a hash of
the challenge and the key, then sends a pipe-delimited subscription line.

Two parts of that are not reconstructible from the published documentation with enough confidence
to ship:

1. The exact composition of the authentication response, including the key-bucket suffix appended
   to the hash.
2. Whether the live gateway accepts `encoding=json`, or whether a full DBN binary decoder is
   required.

Guessing either one produces an adapter that typechecks, passes tests against a fake gateway built
from the same guess, and fails on first contact with the real thing. A `CoverageError` that names
the limitation is more useful than that.

## What clearing this needs

In order:

1. A Databento key, and one successful handshake against the live gateway with their own client to
   capture the wire bytes.
2. If `encoding=json` works, the live adapter is the existing normalizer behind a `net.Socket` and
   a line reader — small.
3. If it does not, a DBN decoder: 8-byte record headers, per-schema fixed-width record bodies, and
   the symbol mapping records that arrive before the data. That is a self-contained piece of work
   and it needs the DBN spec, not inference.

Until then `@conduit/client` will not select Databento for a live subscription, because
`coveringProviders` asks the adapter and the adapter says no. Configuring Databento alongside
Polygon and Alpaca is still correct: it covers historical replay and depth, and the router uses it
for exactly that.
