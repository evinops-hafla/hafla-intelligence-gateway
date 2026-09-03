---
name: event-needs
description: >-
  "What do I need for a <event>?" — the planning bill-of-needs for an event type. Pairs the authored
  IDEAL checklist (core/common/optional needs, the often-forgotten items, budget band, per-guest cost)
  with what Hafla ACTUALLY books for that event (category attach-rates + median unit price). Use for
  "what do I need for a wedding / corporate conference / birthday", "plan a <event>", "checklist for
  <event>", "what should we pitch for a <event>". Read-only, via the EvWA gateway. NOT a single-product
  101 (→ product-brief) and NOT venue evidence (→ venue-recommendation).
---

# event-needs

Answer "what does a **&lt;event&gt;** need?" by composing two lenses no single lookup gives:

1. **The authored IDEAL** — `event_playbook` — core/common/optional needs, the **often-forgotten** items,
   budget band, and (corporate) an indicative per-guest cost. Reference content, not transactions.
2. **What Hafla ACTUALLY books** — `event_need_profile` — category **attach-rate** (% of real orders in
   that family that included the category) + **median unit price**. Real order data.

The value is the **gap between ideal and actual** — what belongs on the checklist, what Hafla really
sells, and what's an upsell/risk (ideal needs that rarely get booked).

> **Delivery model.** Claude Desktop (Chat/Cowork) + Claude Code, tools via the connected gateway. A
> planning checklist is a natural Claude **artifact**. No Slack-terseness / Gemini framing.

## Step 1 — Classify the event: corporate TYPE vs social FAMILY

`event_playbook` has two modes; pick by the event's nature:

- **Corporate** (Conference, Summit, Product Launch, Gala Dinner, Team Offsite…) →
  `event_playbook({ eventType: "<type>" })` → `budgetBand`, `coreNeeds`, `whatMakesItDifferent`,
  `oftenForgotten`, `haflaShouldPitch[]`, `nonCoreNeeds[]`, `indicativePerGuestAed` (p25/med/p75).
  `eventType` fuzzy-matches reasonably well — but always check `matchType` (`exact` vs looser) and
  say when the match was loose.
- **Social / personal** (Wedding, Engagement, Birthday, Baby Shower…) →
  `event_playbook({ family: "<family>" })` → `needs[]` with `importance` (core/common/optional),
  `applies_to`, `conditions`, `often_forgotten`.

**`family` is EXACT-match against 8 enum strings — the user's word alone will error.** The valid
families are exactly:

`Birthday Party` · `Wedding and Engagement` · `Corporate` · `Festive Celebration` ·
`Social Get Together` · `Personal Celebration` · `MICE and Launch Activation` · `Public and School Event`

**Map the user's word to the exact enum before calling** — e.g. "wedding" / "engagement" →
`Wedding and Engagement`; "birthday" → `Birthday Party`; "Diwali" / "Eid" / "Christmas" →
`Festive Celebration`; "exhibition" / "launch" / "activation" → `MICE and Launch Activation`. Calling
`event_playbook({ family: "Wedding" })` fails ("No family matches"); on such an error the tool returns
an `availableFamilies` array — pick the closest family from it and retry (one retry, then say so).
Note: `event_need_profile.eventFamily` (Step 2) DOES prefix-match ("Wedding" works there) — only
`event_playbook.family` is exact.

If unsure which mode, try the corporate `eventType` first; check `matchType`. If neither resolves, say
so and fall back to the actuals (Step 2) alone.

## Step 2 — What Hafla actually books (`event_need_profile`)

`event_need_profile({ eventFamily: "<family term>", limit: 10 })` — `eventFamily` is a **prefix match**
("Wedding" matches "Wedding and Engagement - Wedding"). Returns `familyOrderCount` + `categories[]`:
`{ category, orderCount, attachRatePct, medianUnitAed }`.

- **`attachRatePct` = share of orders touching that category, NOT a partition** — a product can carry
  multiple categories, so percentages **sum above 100% by design**. Never present them as "% of budget".
- **`medianUnitAed` is a SELLING price** (what Hafla charges the client), median per item — label it so.
  It is not a cost and not a per-event total.

## Step 3 — Compose the answer

1. **Checklist** — from `event_playbook`: group by importance (**core → common → optional**); **star the
   `often_forgotten` / `oftenForgotten` items** (that's the differentiated value). Include `conditions`
   (e.g. "mandap Hindu; kosha Arabic", "book 6-12mo ahead").
2. **What we actually sell for it** — from `event_need_profile`: top categories by `attachRatePct`, each
   with `medianUnitAed` (selling). This grounds the checklist in real bookings.
3. **Gaps / upsell** — ideal needs (esp. `often_forgotten`) with **low attach-rate** = frequently missed
   → the pitch. For corporate, lead with `haflaShouldPitch[]`.
4. **Budget** — corporate: `budgetBand` + `indicativePerGuestAed` (× guest count if given). Social: no
   band; use the attach-rate median prices as the cost signal. Label all as **selling / indicative**.
5. State the sources honestly: playbook = **authored reference**, need-profile = **real orders**
   (`familyOrderCount` = the sample; disclose the data window — see the plugin README Freshness rule).

## Output conventions

<!-- OUTPUT-CONVENTIONS:START — keep byte-identical across all skills; verify-skills.mjs enforces this -->
Shared formatting for every EvWA answer (skill-specific structure/order is above):

- **Table by default:** ≥3 comparable rows → a markdown table, one entity per row, with the citation
  key (`orderNumber` / `userEventNumber` / ticket # / partner `tradeName`) as its own column.
- **Money — label every number, and mind the ÷100 trap:** render as `1,250 AED` with a source label
  every time — `(supplier cost, ORDER tier)` / `(selling)` / `(delivery)` / `(estimate)`. The fils→AED
  `÷100` conversion applies **only to raw-SQL money columns** (`Orders.orderTotal`,
  `productPriceBands.*Fils`); every **tool** output (`anchorAed`, `costAed.aed`, `medianUnitAed`,
  `feeAed`, `valueAed`) is **already AED — never re-divide it** (÷100 on an AED tool value is a silent
  100× error).
- **Bands, not extremes:** quote the tier-preferred anchor / median / p25–p75; **never quote a raw
  `min` or `max` as a price** — extremes hold bespoke/bundled outliers (a ~10 AED chair has shown a
  `max` of 1260).
- **Dates:** `D MMM YYYY` in prose, ISO `YYYY-MM-DD` in tables — one format, never a raw source-casing dump.
- **Sources footer** — the last line of every substantive answer, mechanising the citation + freshness
  rules into one predictable place:
  `Sources: <integer keys> · <corpus/mirror> as-of <get_data_freshness>`
  (e.g. `Sources: orders #16504 #16621 · event #4821 · WA corpus as-of 2026-09-03`). Never cite a UUID.
- **Artifact** at ≳8 rows, or on any save / share / compare / forward intent.
<!-- OUTPUT-CONVENTIONS:END -->

## Guardrails / routes out

- **Read-only.** No create/book. This is a **planning brief**, not a quote.
- `attachRatePct` sums &gt;100% by design (share, not partition); `medianUnitAed` /
  `indicativePerGuestAed` are **selling** (client) prices, never cost. **Margin/markup is out of scope**
  (wave-2 commercial-intelligence).
- **Price bands can contain extreme outliers** (bespoke/bundled line items). Quote medians and
  p25–p75 ranges; **never quote a raw `max` as a price.**
- Cite category names + `familyOrderCount`; **never surface UUIDs**.
- **Routes out:** a single product's "101" → `product-brief`; who can supply a need → `supplier-discovery`;
  the price of one product → `pricing-lookup`; where events like this happen (venue evidence) →
  `venue-recommendation`; a specific host's / company's past events → `past-orders`.

## Forward note

Fully **tool-first**: `event_playbook` (ideal) + `event_need_profile` (actual). A future tie-in could
map each playbook need to `catalog_search` / `supplier_discovery` so the checklist links straight to
bookable products + proven suppliers. `seasonal_demand({ dimension })` would add a "when to book" line.
Verify the enterprise install/connector flow on Claude Desktop before wide distribution (see the plugin
README).
