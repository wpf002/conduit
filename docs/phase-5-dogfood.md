# Phase 5 — dogfood in production

Status: **running. Clock starts 2026-09-30; review 2026-10-26.**

The start date moved, and the reason matters. Week 0's numbers were taken on 2026-09-28, but on that
date the integration sat on an unmerged branch and `CONDUIT_BRIDGE` was set by hand for each test — so
nothing routed through Conduit in normal operation and no dogfooding was happening. On 2026-09-30 both
repositories merged to `main` and `CONDUIT_BRIDGE` went into the consumer's `.env`, which is the first
moment real traffic could reach it. Four weeks of live use means four weeks of it actually being
live.

A scheduled review fires on 2026-10-26 and runs the three metrics below. Weeks 1–4 are calendar time,
not work.

This is the go/no-go gate for product-ization. If the first migration takes longer than the original
integration did, Conduit stays an internal package permanently and the roadmap ends here.

## Order

1. **Heaviest consumer first.** It exercises the most surface, so it finds the most problems.
2. **Second consumer** only after the first has run for two weeks without a correctness incident.
3. Everything else is out of scope for this phase.

## Metric 1 — escape hatches leaking into calling code

**Target: trends to zero. Baseline: two fields.**

`docs/cdm-draft.md` records that the CDM does not normalize condition codes or venue identity, and
that nothing else needed a provider-specific path. Any other use of `raw`, or any branch on
`message.provider`, is somewhere the unified-schema premise did not hold.

```bash
node scripts/count-escape-hatches.mjs <consumer-repo>/backend
```

Exits non-zero when it finds an unsanctioned hatch. Record the count weekly:

| Week | files touching Conduit | total | sanctioned | unsanctioned | notes |
|------|------------------------|-------|------------|--------------|-------|
| 0 (2026-09-28) | 2 of 102 | 0 | 0 | 0 | first migration: one source class plus its wiring into the quote path |
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |

Two corrections to the counter came out of running it for the first time, and both would have
produced a meaningless baseline:

- **It scanned no Python.** The extension list was TypeScript and JavaScript only, so against a
  Python consumer it read zero files and reported a clean zero. The first consumer does not import
  Conduit at all — it drives the bridge over NDJSON — so `row["raw"]` and `row["provider"] == "alpaca"`
  are the shapes a hatch takes, and those are now what it looks for. It also prints the file count,
  because "no hatches" and "no files" printed identically before.
- **It counted hatches in code that has nothing to do with Conduit.** Its first real run flagged an
  unrelated `payload.get("raw")` in an intelligence route. A metric whose target is "trends to zero"
  cannot have a floor built out of other people's dictionaries, so only files that mention Conduit
  are counted now.

An unsanctioned count that does not fall is the signal that the project is "three good clients with
a shared shape" rather than one interface, and Phase 6 should not happen.

## Metric 2 — failover events, and whether any corrupted downstream state

**Target: every failover leaves the consumer in order. Thrash count zero.**

```ts
import { ConduitClient, FailoverAudit } from '@conduit/client';

const audit = new FailoverAudit();
const conduit = new ConduitClient({ providers, onEvent: audit.onEvent });
const sub = await conduit.subscribe({ symbols, schema: 'quote_l1' });
audit.watch(sub);

// At the end of a session, or on a timer:
console.log(audit.format());
```

Corruption is not directly observable, but its two mechanisms are:

- **Out-of-order messages reaching the strategy.** `droppedOutOfOrder` counts what the router
  suppressed. A non-zero number is the router working, not a problem.
- **A provider flapping.** `rapidSwitches` counts switches inside 10 seconds of each other. A
  non-zero number means a provider is being marked degraded too eagerly, and `staleAfterMs` or
  `maxConsecutiveFailures` needs raising for that feed.

Record per week:

| Week | switches | degradations | recoveries | dropped | thrash | downstream incidents |
|------|----------|--------------|------------|---------|--------|----------------------|
| 0 (2026-09-28) | 0 | 1 | 0 | 0 | 0 | 0 |
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |

A downstream incident means a position, signal, or backtest result that was wrong and traced to
Conduit. One is enough to stop Phase 6 until it is understood.

## Metric 3 — hours saved versus hours spent

**Target: saved > spent by week 4.**

Not measurable from code. Keep the log here, honestly, including the hours spent debugging Conduit
itself:

| Date | Hours on Conduit | Hours saved in consumer | What |
|------|------------------|-------------------------|------|
| 2026-09-28 | 3 | 0 | First live stream attempt. Three bugs in the socket layer, all invisible to the test suite: auth sent before the server's hello, backoff resetting on every connection, and an unbounded silent retry loop. See [conformance.md](conformance.md#what-running-it-found). |

The week-0 degradation is the one in the table above: Alpaca refused the stream with 406 because the
account's single free-plan data connection is held elsewhere. Counted as a degradation rather than
excused, because from the consumer's side that is exactly what it was.

The comparison that decides the gate is **migration hours versus the original integration hours**.
If the original Polygon integration took 20 hours and migrating it to Conduit takes 25, the
package has not paid for itself and the honest call is to stop.

## Decision rule

| Metric 1 | Metric 2 | Metric 3 | Outcome |
|---|---|---|---|
| trends to zero | clean | saved > spent | Phase 6 is worth considering |
| flat or rising | clean | saved > spent | internal package, scope down to "three clients, one shape" |
| any | downstream incident | any | fix first, restart the four weeks |
| any | any | spent > saved | internal package, roadmap ends |

Three of the four rows end with Conduit staying internal. That is a perfectly good outcome — it
still pays for itself across the portfolio, and it is the expected result rather than the failure
case.
