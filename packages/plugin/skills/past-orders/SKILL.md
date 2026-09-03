---
name: past-orders
description: >-
  "What did we do for X before?" — enumerate every event, order, ticket, and fulfilling partner linked
  to a host, client, partner, event #, order #, ticket #, or a specific product (which orders used it),
  cited by human-readable integer key (orderNumber / userEventNumber / ticket #), newest first. Use for history lookups on a specific
  entity. Identity-federation-first for phone/email/name. Read-only, via the EvWA gateway.
---

# past-orders

Historical lookup: resolve the entity, then enumerate its events/orders/tickets/partners, **cited by
human-readable integer key**, reverse-chronological. Identity federation is the spine — a contact's
WhatsApp / Zendesk / Hafla-Core footprints resolve to one canonical identity before enumeration.

> **Delivery model.** Claude Desktop (Chat/Cowork) + Claude Code, tools via the connected gateway. Offer
> a Claude **artifact** for a long order/event history (a clean timeline table). No Slack-terseness /
> Gemini framing.

## Always state the coverage window (FU-7 pre-emption)

Open every response with: "History window: orders **2021 → present** (dense from 2023; ~1,120 rows
pre-2023). I cite `orderNumber` / `userEventNumber` / ticket #, never UUIDs." This pre-empts the #1
failure mode (coverage push-back). For the exact as-of, `get_data_freshness` → `haflaCoreMirror.lastSyncAt`
(the ~4h order mirror these reads run against).

## Step 1 — Identify the input (8 shapes) and resolve it

| Input                    | Resolve with                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **host phone / email**   | `analyze_identity_graph({ phone_or_email: "<value>" })` → canonical identity unifying WA/ZD/HC. Also `customer_360({ mobile: "<value>" })` / `customer_360({ email: "<value>" })` for the lifetime summary. |
| **Zendesk ticket #**     | `get_ticket_360({ ticket_id: "<n>" })` (bundled context — preferred; `ticket_id` is a string).                                                                                                              |
| **event # / host #**     | `get_lead_context({ userEventNumber })` / `get_lead_context({ hostNumber })`.                                                                                                                               |
| **order #**              | `safe_sql_sandbox` (Branch-Order below).                                                                                                                                                                    |
| **partner name**         | `safe_sql_sandbox` (Branch-Partner) — their fulfilled orders.                                                                                                                                               |
| **company / org (email domain)** | `get_org_events({ orgDomain: "<domain>" })` — a company's full event history keyed on **email domain** (haflaCore has no org table; the domain IS the org identity). Rejects consumer/placeholder/`hafla.com` domains; unknown-but-valid → empty list, not an error. Returns events (title, date, contact, guests, `valueAed` — a **pre-sale estimate**, not a realized order total; check `valueBasis`). **The clean path for a corporate buyer** (e.g. "AUS" → `aus.edu`) — far better than name-matching. **Presentation:** the result can be large (e.g. `aus.edu` → 129 events) with many null dates and near-duplicate titles — state the total `eventCount`, sort by date desc with **null-dated rows last** (grouped count-only, e.g. "+61 more without a logged date"), dedupe obvious repeats (same title + contact), cap the printed table at ~15–20 rows with an offer to widen, and label every `valueAed` as an **estimate**. |
| **client / host NAME**   | mandatory fallback chain: `Users.name` → `UserEvents.eventTitle` → ZD subject → corpus (corporate buyers live in event titles / ticket subjects, not `Users.name`). **If it's a company with a known email domain, use `get_org_events` (row above) instead of name-matching.** |
| **a specific product** (which orders/events used it) | **Branch-Product** (`safe_sql_sandbox`) — enumerate the orders that included the product. A bare product name for a *101* or *sourcing/pricing* intent instead routes to `product-brief` / `supplier-discovery` / `pricing-lookup`. |

## Step 2 — Lead with `customer_360` for a host, then enumerate

For a resolved host (mobile/email), call `customer_360` first for the profile
(`bookedOrders`, `lifetimeAed`, `avgOrderAed`, cadence, `segmentHint`, ranked `tasteCategories`,
`isAggregateAccount`). Flag `isAggregateAccount: true` — the profile aggregates a shared/agency account,
so per-event breakdowns matter more than lifetime totals.

Then enumerate the actual orders/events (the tool gives counts, not the list) via `safe_sql_sandbox`:

```sql
-- resolve name→userId first if needed; here :userId is the resolved host
SELECT o."orderNumber", ue."userEventNumber", ued."eventTitle",
       o.status, o."createdAt"::date AS "orderedOn",
       (o."orderTotal"/100.0)::numeric(12,2) AS "orderAed"   -- Orders.orderTotal is in fils
FROM "haflaCore"."Orders" o
LEFT JOIN "haflaCore"."UserEvents" ue ON ue.id = o."userEventId"
LEFT JOIN LATERAL (                                    -- eventTitle lives on UED, which has
  SELECT d."eventTitle"                                -- MULTIPLE rows per event → LATERAL LIMIT 1
  FROM "haflaCore"."UserEventDetails" d                -- to avoid fanning out / duplicating orders
  WHERE d."userEventId" = ue.id LIMIT 1
) ued ON true
WHERE o."userId" = :userId
ORDER BY o."createdAt" DESC
LIMIT 25;
```

For per-order partners: join `OrderItems → OrderItemPartners → Partners` (cite `tradeName`).

### Branch-Order — order # given (`safe_sql_sandbox`)

`WHERE o."orderNumber" = :n::integer` → its items, quantities, partners, event #.

### Branch-Partner — partner name (`safe_sql_sandbox`)

`OrderItemPartners → Partners WHERE pt."tradeName" ILIKE '%'||:partner||'%'` → the orders that partner
fulfilled, newest first, cited by `orderNumber`.

### Branch-Product — "which orders included product X" (`safe_sql_sandbox`)

For "which orders/events used <product>" (a *history* enumeration, not a 101/sourcing question — those
route out). **Two legs**, because ~55% of GMV is generic/bespoke line items whose name lives in notes,
not the catalog:

```sql
-- (a) CATALOG product by name — the common case
SELECT o."orderNumber", p.name AS "product", o."createdAt"::date AS "orderedOn",
       max(pt."tradeName") AS "aPartner"
FROM "haflaCore"."Products" p
JOIN "haflaCore"."OrderItems" oi          ON oi."entityId" = p.id
JOIN "haflaCore"."Orders" o               ON o.id = oi."orderId"
LEFT JOIN "haflaCore"."OrderItemPartners" oip ON oip."orderItemId" = oi.id
LEFT JOIN "haflaCore"."Partners" pt       ON pt.id = oip."partnerId"
WHERE p.name ILIKE '%'||:term||'%'
GROUP BY o."orderNumber", p.name, o."createdAt"
ORDER BY o."createdAt" DESC LIMIT 20;
```

If leg (a) is empty, the term is likely a **generic/bespoke** item (e.g. "eggs painting" — verified: 0
catalog rows, but present in `productNotes`). Fall back to the notes leg before concluding "no orders":

```sql
-- (b) GENERIC/bespoke line items recorded in notes
SELECT o."orderNumber", o."createdAt"::date AS "orderedOn", oi."productNotes"  -- Slate JSON → flatten
FROM "haflaCore"."OrderItems" oi
JOIN "haflaCore"."Orders" o ON o.id = oi."orderId"
WHERE oi."productNotes"::text ILIKE '%'||:term||'%'
ORDER BY o."createdAt" DESC LIMIT 20;
```

Cite `orderNumber`; `productNotes` is **Slate JSON** (`[{children:[{text}]}]`) — flatten `.children[].text`.

## Signature UX — the FU-4 scope pivot

On "all Rixos, not just RAK" / "apart from event #123, others?", widen the filter and re-enumerate.
Offer it on every response ("want all events for this host / venue / partner, not just this one?").

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

- Read-only. Cite `Orders.orderNumber` / `UserEvents.userEventNumber` / ticket # — **never UUIDs**.
- **Source-honesty:** the name-fallback's corpus leg (`search_internal_knowledge`) is **WhatsApp only** —
  Zendesk/Slack are reachable structurally (via `get_ticket_360` / SQL), not semantically.
- State the real window; on thin data say "thin, not absent" and cite what was found.
- **Routes out:** "who can supply X" → `supplier-discovery`; "what does X cost" → `pricing-lookup`;
  "101 on X" → `product-brief`; "where do <pax>-events happen / venue evidence" → `venue-recommendation`;
  "what do I need for a <event>" → `event-needs`.
  PII (host phone/email) is returned for internal planner use (D-9).

## Forward note

Tool-first for resolution + host profile (`analyze_identity_graph`, `get_lead_context`,
`get_ticket_360`, `customer_360`). The order/event **enumeration** is still raw `safe_sql_sandbox` (no
per-host order-list tool yet) — a future `host_orders` / `event_360` tool would complete the
tool-first path. Verify the enterprise install/connector flow on Claude Desktop (see the plugin README).
