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

## Step 0 — Parse the constraint band

Extract pax, area/emirate, budget, indoor/outdoor, vibe. Only pax/site-type/address are structurally
present; **echo the rest but say they aren't filterable** (no structured vibe/budget-per-venue model).
**Confirm the exact `UserEventDetails` column names with `describe_table({ table: "UserEventDetails" })`
before running the SQL** (guest-count / site-type / address column names must be verified, not assumed).

## Step 1 — Site-type mix + recurring venues (`safe_sql_sandbox`)

`UserEventDetails (UED)` carries the venue evidence: `eventSiteTypeId → "EventSiteTypes"` (24
categories) and `exactAddress`. Aggregate what events in the pax band used:

```sql
-- verify column names via describe_table first; :paxLo/:paxHi are the parsed band
SELECT est."name" AS "siteType",
       count(*) AS "events",
       count(DISTINCT ued."exactAddress") FILTER (WHERE ued."exactAddress" IS NOT NULL) AS "distinctVenues"
FROM "haflaCore"."UserEventDetails" ued
JOIN "haflaCore"."EventSiteTypes" est ON est.id = ued."eventSiteTypeId"
-- WHERE ued.<guestCountColumn> BETWEEN :paxLo AND :paxHi     -- confirm the column name
GROUP BY est."name"
ORDER BY "events" DESC;
```

Then list the specific recurring venues (top `exactAddress` values in the band), each cited by the
`userEventNumber` / `orderNumber` of an example event so the planner can verify.

## Step 2 — Vendors who served those venues (the re-scope's defining feature)

For the recurring venues, surface the vendors/partners who served events there:

- Where federation links exist, the proven-fulfilment path (`OrderItemPartners → Partners` on those
  events' orders) — cite `tradeName`.
- `search_internal_knowledge({ query: "<venue or area> event vendor catering AV parking" })` — the WA corpus
  (**WhatsApp only**) carries venue mentions + vendor names + alcohol/parking/capacity context that
  lives nowhere structured. Disclose the corpus date; cite chat title.

## Guardrails / routes out

- **Not a recommender** — never assert "best venue"; present evidence + counts, let the planner decide.
- Cite `userEventNumber` / `orderNumber` — **never UUIDs**.
- **Hard-deflect commercials:** any markup / margin / per-venue-profit question → "that's
  commercial-intelligence, out of scope for this skill" (route to the future wave-2 skill). Do not
  compute margin here.
- Read-only. Non-filterable constraints (vibe/budget) are echoed, not silently applied.

## Forward note

Evidence-only by design — there is no venue catalog and no venue tool, so this stays raw
`safe_sql_sandbox` + `search_internal_knowledge`. If a structured venue/site model is ever built, this
skill can become a real recommender; until then it is scoped down to evidence. Verify the `UED` column
names with `describe_table` and the enterprise install/connector flow on Claude Desktop (see the plugin
README).
