---
name: venue-recommendation
description: >-
  Evidence lookup (NOT a recommender) for venues — given pax / area / budget / indoor-outdoor / vibe,
  return what PAST Hafla events in that band actually did: the venue site-type mix, the specific venues
  that recur, and the vendors/partners who served events there. Use for "where do people do 200-pax
  outdoor events / what venues for a corporate gala". Read-only, via the EvWA gateway. There is no
  venue catalog to recommend from — this surfaces evidence, cited by event # / order #.
---

# venue-recommendation

**Evidence-only.** Hafla has no venue catalog to recommend from, so this skill does NOT recommend — it
returns **what comparable past events actually used**. Every response opens with that disclosure.

> **Delivery model.** Claude Desktop (Chat/Cowork) + Claude Code, tools via the connected gateway. A
> venue-evidence summary is a good Claude **artifact**. No Slack-terseness / Gemini framing.

## Always open with the RED-readiness disclosure

"I don't have a venue catalog to recommend from — here's **what past Hafla events at this
pax/budget/type actually did**: the site-type mix, the venues that recur, and the vendors who served
them. Cited by event # / order #."

State the coverage honestly in the disclosure (verified on prod, 429,870 event-detail rows): only
**~17.6%** of events carry a **site-type** and only **~4%** a **named address** (`exactAddress`) — most
events are homes (Villa/Apartment) with neither. So both signals are **partial samples**, and the
default window is **the last 24 months of actual event dates** (pre-2024 data is near-zero) — apply
`WHERE ued."eventDate" > now() - interval '24 months' AND ued."eventDate" <= now()`. Use
**`eventDate`** (when the event happened), NOT `createdAt` (when the row was inserted — a booking
entered yesterday for an event 10 months out is not past evidence); the upper bound excludes
future-dated bookings, since this skill reports what past events **did**.

## Step 0 — Parse the constraint band

Extract pax, area/emirate, budget, indoor/outdoor, vibe. Only pax/site-type/address are structurally
present; **echo the rest but say they aren't filterable** (no structured vibe/budget-per-venue model).
**Confirm the exact `UserEventDetails` column names with
`describe_table({ schema: "haflaCore", table: "UserEventDetails" })` before running the SQL** (both
`schema` and `table` are required) (guest-count / site-type / address column names must be verified, not assumed).

## Step 1 — Site-type mix AND recurring venues — TWO separate queries (`safe_sql_sandbox`)

`UserEventDetails (UED)` carries two venue signals that live on **near-disjoint rows**:
`eventSiteTypeId → "EventSiteTypes"` (24 categories) and the free-text `exactAddress`. **Verified on
prod: in a typical pax band they have ~ZERO overlap** (180–220 pax: 1,673 rows carry a site-type, 189
carry an address, **0 carry both**). So an INNER JOIN to `EventSiteTypes` discards every
address-bearing row, and any `count(DISTINCT exactAddress)` inside that joined result is **always 0**.
**Run these as two independent queries — never one combined block** (`expectedGuestCount` is the pax
column; confirm via `describe_table`).

**1a — site-type mix** (reliable — ~430K events carry a site-type overall):

```sql
-- :paxLo/:paxHi = parsed band
SELECT est."name" AS "siteType", count(*) AS "events"
FROM "haflaCore"."UserEventDetails" ued
JOIN "haflaCore"."EventSiteTypes" est ON est.id = ued."eventSiteTypeId"
WHERE ued."expectedGuestCount" BETWEEN :paxLo AND :paxHi
  AND ued."eventDate" > now() - interval '24 months'
  AND ued."eventDate" <= now()          -- past evidence only: exclude future-dated bookings
GROUP BY est."name"
ORDER BY "events" DESC;
```

**1b — recurring named venues** (INDEPENDENT — no site-type join, since the two columns don't co-occur):

```sql
SELECT ued."exactAddress", count(*) AS "events",
       max(ue."userEventNumber") AS "exampleEventNumber"   -- the citation key
FROM "haflaCore"."UserEventDetails" ued
JOIN "haflaCore"."UserEvents" ue ON ue.id = ued."userEventId"
WHERE ued."expectedGuestCount" BETWEEN :paxLo AND :paxHi
  AND ued."eventDate" > now() - interval '24 months'
  AND ued."eventDate" <= now()          -- past evidence only: exclude future-dated bookings
  AND ued."exactAddress" IS NOT NULL
GROUP BY ued."exactAddress"
HAVING count(*) >= 2
ORDER BY "events" DESC
LIMIT 15;
```

Cite each recurring venue by its `exampleEventNumber` (`userEventNumber`) so the planner can verify.

> **Caveat (verified on prod):** `exactAddress` is populated for only **~4%** of events (most are homes
> — Villa/Apartment — with no named venue), so 1b is **sparse and illustrative, not comprehensive**.
> Lead with the **site-type mix (1a)** (reliable) and the **corpus** (Step 2); present named venues as
> "some past events used…", never "the venues for this band".

## Step 2 — Vendors who served those venues (the re-scope's defining feature)

For the recurring venues, surface the vendors/partners who served events there:

- Where federation links exist, the proven-fulfilment path (`OrderItemPartners → Partners` on those
  events' orders) — cite `tradeName`.
- `search_internal_knowledge({ query: "<venue or area> event vendor catering AV parking" })` — the WA corpus
  (**WhatsApp only**) carries venue mentions + vendor names + alcohol/parking/capacity context that
  lives nowhere structured. Disclose the corpus date (`waCorpusGeneration.lastSyncAt` via
  `get_data_freshness`); cite chat title.

## Guardrails / routes out

- **Not a recommender** — never assert "best venue"; present evidence + counts, let the planner decide.
- Cite `userEventNumber` / `orderNumber` — **never UUIDs**.
- **Hard-deflect commercials:** any markup / margin / per-venue-profit question → "that's
  commercial-intelligence, out of scope for this skill" (route to the future wave-2 skill). Do not
  compute margin here.
- Read-only. Non-filterable constraints (vibe/budget) are echoed, not silently applied.
- **Routes out:** a specific vendor who can supply X → `supplier-discovery`; what a vendor charges / a
  product's price → `pricing-lookup`; a host's full event history → `past-orders`; a product "101" →
  `product-brief`; "what do I need for a &lt;event&gt;" (planning checklist) → `event-needs`.

## Forward note

Evidence-only by design — there is no venue catalog and no venue tool, so this stays raw
`safe_sql_sandbox` + `search_internal_knowledge`. If a structured venue/site model is ever built, this
skill can become a real recommender; until then it is scoped down to evidence. Verify the `UED` column
names with `describe_table` and the enterprise install/connector flow on Claude Desktop (see the plugin
README).
