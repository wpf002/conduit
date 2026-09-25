# Phase 0 gate 1 — licensing probe

Status: **closed on the published terms. The emails are not being sent** (operator decision,
2026-09-25). The drafts below are kept for reference only; nothing here is a pending action.

What that costs: the exchange redistribution pricing stays unknown, so the hosted design with cost
routing cannot be priced and therefore cannot be chosen. BYO-key stands as the architecture by
default rather than by comparison. If that question ever matters, the drafts are ready.

## Why this gate exists

The BYO-key architecture has zero redistribution exposure because market data never transits
Conduit-operated infrastructure. That claim needs confirmation from the two vendors with the
strictest terms before any adapter code is worth writing. The second question is the more
important one: if a redistribution agreement is cheap, the hosted design with cost routing beats
this one outright and the roadmap should be reconsidered rather than continued.

## Email 1 — Polygon.io business development — not sent

> **To:** bd@polygon.io
> **Subject:** Terms question: client library where each user supplies their own API key
>
> Hi,
>
> I'm building an open-source TypeScript client library for market data. The architecture is
> bring-your-own-key: each user configures their own Polygon API key, the library runs inside
> their own process, and data flows directly from your API to their machine. No component I
> operate ever receives, stores, caches, or forwards quotes, trades, or bars — or anything
> derived from them. The only thing any hosted piece would ever see is metadata: which providers
> a user configured, health signals, request counts, and symbol identifiers.
>
> Two questions:
>
> 1. I read §6.1(e) as permitting Information to reach my Edge Users, and §2.2 as covering use in
>    applications I own — while §2.1 keeps the API itself internal. Is that the right reading for a
>    library where each user holds their own Massive account and key?
> 2. If I later served data from my own infrastructure instead, which Third-Party Agreements would
>    I need to hold as a redistributor, and roughly what do those exchanges charge? I want to price
>    the option even though the current design doesn't require it.
>
> Happy to send the architecture diagram if that's useful.
>
> Thanks,
> Will Foti

**Reply:** n/a — not sent.

## Email 2 — Databento business development — not sent

> **To:** sales@databento.com
> **Subject:** Terms question: BYO-key client library, no data through our infrastructure
>
> Hi,
>
> I'm building an open-source TypeScript client library that normalizes several market data
> vendors behind one interface. Each user supplies their own Databento API key and the library
> runs in their own process — data goes from your API straight to their machine. Nothing I
> operate touches raw or derived market data; any hosted component sees only configuration,
> health signals, and usage counters.
>
> 1. Does that fall within your standard licence as a licensed-user tool rather than
>    redistribution, given each user holds their own Databento account?
> 2. If I later served data from my own infrastructure, your licensing guide says you'd introduce
>    me to each exchange for an ILA. For a US equities and futures product, which exchanges would
>    that be, and what is the realistic annual cost of that set?
>
> Thanks,
> Will Foti

**Reply:** n/a — not sent.

## What the published terms already answer

Read 2026-09-24 from the vendors' own pages, before sending anything. Not legal advice, and the
Third-Party Agreements that actually govern the data are not public.

**Polygon is now Massive** (polygon.io/terms redirects to massive.com/legal). The business terms
were last updated 2025-09-02, so the roadmap's characterisation of them is dated.

| Finding | Source |
|---|---|
| The use restriction forbids making Information available "to anyone other than Customer, its Authorized Users, or its **Edge Users**" — and Edge Users are defined as users of the Customer's own products and services. Redistribution to your own end users is contemplated by the standard business terms, not prohibited outright. | Massive Businesses ToS §6.1(e), §1 |
| The Information grant covers use "in websites or software applications owned or licensed by Customer". The *Services and API* are separately restricted to internal purposes, so reselling API access is out. | §2.2 vs §2.1 |
| Third-Party Data is governed by Third-Party Agreements the Customer must obtain itself, and Massive may cut off any unlicensed portion. | §2.5 |
| Databento's own guidance: redistribution requires a formal exchange licence or ILA per exchange (Nasdaq, CME, OPRA). The exchange must speak with you to set your status and fees, it cannot be automated, and a redistribution fee applies even when you go through a vendor — for historical data at some exchanges too. | Databento licensing guide, parts 1–3 |

**So the gate is not the vendor, it is the exchanges.** Both vendors permit serving your own end
users under their own terms; what costs money and time is the per-exchange redistribution licence
sitting underneath. That is quote-only and involves a conversation with each exchange.

### What this changes

- **BYO-key is comfortably within terms.** Each user is their own Customer holding their own
  Third-Party Agreements. Nothing in Phases 1–4 is at risk.
- **The hosted alternative is legally contemplated but not cheap.** The "stop and reconsider"
  branch is not triggered by the vendor terms; it would be triggered by an exchange redistribution
  quote coming back affordable, which is a different and slower question.

## Resolution

| Question | Polygon / Massive | Databento |
|---|---|---|
| BYO-key within terms? | yes, on the published terms | yes, on the published guidance |
| End-user (Edge User) redistribution permitted by the vendor? | yes, §6.1(e) | yes, with an exchange ILA |
| Exchange redistribution licence cost | **still unknown — quote only** | **still unknown — quote only** |

**Decision, 2026-09-25.** The gate is closed on the published terms. BYO-key is within terms for both
vendors, which is what Phases 1–4 depend on, and that part needed no reply.

The unanswered half — what exchange redistribution licences cost — stays unanswered, because the
emails are not being sent. The consequence is recorded rather than papered over: the hosted design
with cost routing is not ruled out on legal grounds, it is simply unpriced, so it cannot be compared
and will not be built. Anyone reopening that question starts by sending Email 1 and Email 2.
