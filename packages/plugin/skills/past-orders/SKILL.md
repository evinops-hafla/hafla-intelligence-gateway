---
name: past-orders
description: >-
  "What did we do for X before?" — enumerate every event, order, ticket, and fulfilling partner linked
  to a host, client, partner, event #, order #, ticket #, or product, cited by human-readable integer
  key (orderNumber / userEventNumber / ticket #), newest first. Use for history lookups on a specific
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
failure mode (coverage push-back).

## Step 1 — Identify the input (7 shapes) and resolve it

| Input                    | Resolve with                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **host phone / email**   | `analyze_identity_graph({ phone_or_email: "<value>" })` → canonical identity unifying WA/ZD/HC. Also `customer_360({ mobile: "<value>" })` / `customer_360({ email: "<value>" })` for the lifetime summary. |
| **Zendesk ticket #**     | `get_ticket_360({ ticket_id: "<n>" })` (bundled context — preferred; `ticket_id` is a string).                                                                                                              |
| **event # / host #**     | `get_lead_context({ userEventNumber })` / `get_lead_context({ hostNumber })`.                                                                                                                               |
| **order #**              | `safe_sql_sandbox` (Branch-Order below).                                                                                                                                                                    |
| **partner name**         | `safe_sql_sandbox` (Branch-Partner) — their fulfilled orders.                                                                                                                                               |
| **client / host NAME**   | mandatory fallback chain: `Users.name` → `UserEvents.eventTitle` → ZD subject → corpus (corporate buyers live in event titles / ticket subjects, not `Users.name`).                                         |
| **product / topic only** | this is a discovery question, not a history one — route to `supplier-discovery` (who supplies) or `pricing-lookup` (what it cost).                                                                          |

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

## Signature UX — the FU-4 scope pivot

On "all Rixos, not just RAK" / "apart from event #123, others?", widen the filter and re-enumerate.
Offer it on every response ("want all events for this host / venue / partner, not just this one?").

## Guardrails / routes out

- Read-only. Cite `Orders.orderNumber` / `UserEvents.userEventNumber` / ticket # — **never UUIDs**.
- State the real window; on thin data say "thin, not absent" and cite what was found.
- **Routes out:** "who can supply X" → `supplier-discovery`; "what does X cost" → `pricing-lookup`;
  "101 on X" → `product-brief`. PII (host phone/email) is returned for internal planner use (D-9).

## Forward note

Tool-first for resolution + host profile (`analyze_identity_graph`, `get_lead_context`,
`get_ticket_360`, `customer_360`). The order/event **enumeration** is still raw `safe_sql_sandbox` (no
per-host order-list tool yet) — a future `host_orders` / `event_360` tool would complete the
tool-first path. Verify the enterprise install/connector flow on Claude Desktop (see the plugin README).
