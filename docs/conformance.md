# Conformance without a provider key

Written when Conduit had never spoken to a live market data API. It has since — an Alpaca key arrived
and the REST paths, the reference loaders and the stream handshake have all run against the real
service. **[What running it found](#what-running-it-found) is the part to read**; the rest records how
much was settled before any key existed, which is most of it.

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

Honest limits. Struck through where a live Alpaca key has since settled it.

- ~~**Auth.** No key means no proof the auth handshake works, for any provider.~~ **Settled for
  Alpaca.** REST auth works; `summary()` and both reference loaders return real data. The stream's
  auth handshake is written correctly but has not completed — see below.
- ~~**Reconnect against a real server.**~~ **Settled for Alpaca.** A real rejection loop was
  exercised for over two minutes: real close codes (1006, no close frame), real error frames, and
  backoff growing 264ms → 35s across eleven attempts.
- **Rate limits.** Still unverified for Databento.
- **Entitlement errors.** Alpaca's error codes have been seen for real only at 406. Whether a 403
  body looks the way the adapter assumes is still unknown.
- **Sustained behaviour.** Memory over a session, socket stability over hours, behaviour across a
  market open and close. Untested.
- **Data correctness.** Every committed fixture is still synthetic or vendor-authored. The live
  snapshot numbers were plausible and matched across symbols, which is not the same as verified
  against the tape.

## What running it found

Three bugs on 2026-09-28, during market hours, on the first attempt to stream. Every one of them was
invisible to 191 passing tests, because the fake server implemented what the adapter expected.

### The adapter authenticated before the server said hello

`onOpen` sent the auth frame the instant the socket opened. Alpaca sends
`{"T":"success","msg":"connected"}` first and authenticates only after that, and its own SDK waits for
that hello. The premature frame was ignored, Alpaca never answered, and the socket sat open and
silent until its 10-second auth timeout. Auth now goes out from the hello handler. Polygon had the
same ordering and was fixed with it, though it is unverified against a real Polygon server.

### Backoff reset on every connection, so a rejected socket retried at full speed

`#attempt = 0` lived in the socket's `'open'` handler. A socket rejected at the *application* level
completes its handshake perfectly, so every retry looked like the first retry: the delay never grew
and the provider got hammered at the base interval indefinitely. The counter now resets only when the
caller reports the connection productive — authenticated, subscribed, delivering.

### A socket that was never going to work retried forever in silence

Alpaca's 406 is `RateLimitError`, which is retryable, so the handler incremented a health counter and
left the socket alone. Nothing bounded it. `conduit stream AAPL` printed
`streaming quote_l1 for AAPL from alpaca` and then produced no data, no error and no control message,
for as long as it was left running. Three changes:

| Change | Effect |
|---|---|
| `maxUnproductiveAttempts` (default 4) | the consumer is told, with the noted error's own class, so the router sees a connection cap as a rate limit rather than a dead key |
| `productiveTimeoutMs` (default 10s) | an open socket that never authenticates is terminated and retried; the keepalive could not catch this, because pings were answered |
| terminate on a pre-auth rejection | Alpaca holds the socket open until its own 10s auth timeout after sending 406, so each retry cost ten seconds of silence |

Measured on the same key afterwards: **4.4 seconds to a `RateLimitError` reading
`alpaca connection limit reached (406): connection limit exceeded`**, in place of indefinite silence.

## The test stream settles most of what was left

Alpaca runs `wss://stream.data.alpaca.markets/v2/test`, a real Alpaca server speaking the real
protocol with synthetic ticks on the symbol `FAKEPACA`. It needs no data entitlement and does not
contend for the production feed's single connection, so it works on a free key, outside market hours,
while the production slot is held by somebody else. `scripts/live-conformance.mjs` (`pnpm live`) runs
against it, and it is the check that would have caught all three bugs above.

What it settles, against the vendor's own implementation rather than a fake written from the vendor's
documentation:

| Check | Result |
|---|---|
| Stream auth handshake | authenticates in ~200ms |
| Subscription acknowledgement | `{"T":"subscription","trades":["FAKEPACA"],"quotes":["FAKEPACA"]}` |
| Normalization of trades and quotes | zero `SchemaError`, zero CDM invariant failures |
| Nanosecond precision | every `tsEvent` bigint matches the nanoseconds in the vendor's own ISO string |
| Real mid-stream connection drop | `terminate()` with no close frame; auth and subscriptions replay, data resumes, health returns to `healthy` |
| Derived flags | a size-3 trade normalizes to `OddLot \| Derived`, and the venue is the vendor's own `"N"` rather than a fabricated MIC |

### What is still not verified

**No real price.** The test stream's ticks are invented, so nothing here proves that a price Conduit
emits equals a price that printed. That is the one remaining gap and it needs two things: the
production feed, and a second source to compare against.

Production ticks have not been received. Alpaca's free plan allows one concurrent data connection and
something outside this machine holds the account's slot: after a 5½-minute quiet window with nothing
of ours connected, all eleven attempts were refused with 406 within ~44ms each. The account is
`ACTIVE` and REST works, so this is a connection cap rather than entitlement, and `lsof` found no
local process holding it — it is a server-side session. Freeing the slot or adding a second key is all
that is needed; no code change is pending on it.

Also still unverified: sequence numbering against a real multi-symbol feed (the test stream carries
one symbol), behaviour across a market open and close, and Polygon's handshake, which was corrected
alongside Alpaca's but has never met a real Polygon server.
