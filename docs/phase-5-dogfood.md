# Phase 5 — dogfood in production

Status: **not started.** Phases 0–4 are built and tested; this phase is four weeks of live use in
Crossbar and then Prophet, which needs provider keys and calendar time. What is built here is the
apparatus for measuring it, so the gate is decided by numbers rather than by recollection.

This is the go/no-go gate for product-ization. If migrating Crossbar takes longer than the original
integration did, Conduit stays an internal package permanently and the roadmap ends here.

## Order

1. **Crossbar first.** It is the heaviest market data consumer, so it exercises the most surface.
2. **Prophet second**, only after Crossbar has run for two weeks without a correctness incident.
3. Touchstone is out of scope for this phase.

## Metric 1 — escape hatches leaking into calling code

**Target: trends to zero. Baseline: two fields.**

`docs/cdm-draft.md` records that the CDM does not normalize condition codes or venue identity, and
that nothing else needed a provider-specific path. Any other use of `raw`, or any branch on
`message.provider`, is somewhere the unified-schema premise did not hold.

```bash
node scripts/count-escape-hatches.mjs ../crossbar/src
```

Exits non-zero when it finds an unsanctioned hatch. Record the count weekly:

| Week | total | sanctioned | unsanctioned | notes |
|------|-------|------------|--------------|-------|
| 0 (pre-migration) | | | | |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |

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
| | | | |

The comparison that decides the gate is **migration hours versus the original integration hours**.
If Crossbar's original Polygon integration took 20 hours and migrating it to Conduit takes 25, the
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
