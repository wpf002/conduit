# Conformance without a provider key

Conduit has never spoken to a live market data API and may not for some time. This records how to
get most of what live testing would give you anyway, and what it cannot give you.

## The idea

Every vendor maintains an open-source client SDK. Those SDKs contain the vendor's own encoders,
decoders, test fixtures and wire-format assertions — written by the people who built the feed, and
kept current because their users depend on them. That is a primary source, and it is public.

Documentation tells you what a vendor says the format is. **SDK source tells you what it actually
does**, including the cases the docs omit.

| Source | License | What it settles |
|---|---|---|
| [databento/dbn](https://github.com/databento/dbn) | Apache-2.0 | Record flag bits, price scale, undefined sentinels, and how the JSON encoder renders every field type |
| [databento/databento-python](https://github.com/databento/databento-python) | Apache-2.0 | Which encoding their own client requests, and the defaults it sends |
| [alpacahq/alpaca-trade-api-js](https://github.com/alpacahq/alpaca-trade-api-js) | Apache-2.0 | Stream wire format, codec negotiation, timestamp precision handling |

## What this found

Three passes over vendor docs found three bugs (see [cdm-draft.md](cdm-draft.md)). One pass over
vendor *source* found two more that no amount of documentation reading would have caught.

### Databento's JSON has two shapes per numeric field

`rust/dbn/src/encode/json/serialize.rs` chooses per field, and the choice is not cosmetic:

| | `pretty_px=false` | `pretty_px=true` |
|---|---|---|
| A price | `"185110000000"` — fixed-point int64 as a **string**, "to avoid a loss of precision" | `"185.110000000"` — already decimal |
| An absent price | int64 max | `null` |
| A timestamp | `"1704205800123456789"` — string | formatted, or `null` when zero or undefined |

The adapter read only the first column. A `pretty_px=true` response would have divided every price
by a billion, and a null would have thrown. It now reads both shapes and pins `pretty_px=false` and
`pretty_ts=false` in the request so the format is never inherited from a server default.

A record whose `ts_event` is `null` is now skipped rather than rejected: the encoder writes null for
a zero or undefined timestamp, which is how error and system records render, and a record with no
event time is not market data.

### Alpaca's market data stream is msgpack by default

Their own SDK says so in a comment — *"Market data is msgpack; trading is JSON"* — and defaults its
codec to msgpack. JSON is what you get when the connection does **not** send
`Content-Type: application/msgpack`, which is what Conduit does, so the adapter is correct.

But `ReconnectingSocket` passed every frame to `toString()` and then `JSON.parse`, so a binary frame
would have produced an opaque parse failure on every message with nothing pointing at the cause. It
now detects a binary frame and reports one error naming msgpack.

The cost of staying on JSON is more bytes and more parse time per tick than msgpack. That is a
deliberate trade for a 10–500ms target tier, not an oversight, and it is the obvious optimisation if
message rates ever become the constraint.

## How to do another pass

1. Find the vendor's official SDK and check its licence.
2. Read the **encoder and decoder**, not the docs. Every branch is a format you must handle.
3. Read their test fixtures. They are real captured payloads.
4. Grep their client for the request parameters it sets by default. Anything they pin, pin too —
   they pinned it for a reason.
5. Write a test per branch you find, with the source file named in a comment.

## What this cannot give you

Honest limits, so this is not mistaken for having run the thing:

- **Auth.** No key means no proof the auth handshake works, for any provider.
- **Reconnect against a real server.** The fake servers reconnect correctly because they implement
  what the adapter expects. A real server's close codes, timing and quirks are untested.
- **Rate limits.** Whether the governor's ceilings match reality is unverified for Databento.
- **Entitlement errors.** `conduit doctor` distinguishes revoked from unentitled keys in tests
  against a fake adapter. Whether a real 403 body looks the way the adapter assumes is unknown.
- **Sustained behaviour.** Memory over a session, socket stability over hours, behaviour across a
  market open and close.
- **Data correctness.** Every fixture in this repo is synthetic or vendor-authored. Nothing proves
  that a price Conduit emits equals the price that printed.

The first four are each a single afternoon once any key exists, including a free one.
