---
name: supplier-discovery
description: >-
  Find Hafla suppliers/partners for a product, service, or category and rank them by PROVEN
  fulfilment (real past orders), not a reliability score. Use when the user asks "who can give / who
  provides / supplier for / top suppliers for X", pastes a terse multi-constraint sourcing request
  (product + date + city + qty + a denied/already-tried vendor list), or wants the "invisible" supply
  chain (partners talked to in WhatsApp but never registered). Read-only. Talks to the EvWA
  Intelligence gateway (mcp.hafla.com) via the connected MCP tools.
---

# supplier-discovery

Answer supplier/vendor sourcing questions by ranking partners on **proven fulfilment first**. This
skill orchestrates the read-only EvWA Intelligence gateway tools — it never writes, and it never
invents a reliability score (none exists in the data).

> **Delivery model (2026-08-13 correction).** This skill targets **Claude Desktop (Chat/Cowork)** and
> Claude Code, with tools reached through the connected EvWA gateway (MCP). It is NOT a Slack bot and
> is NOT built for Gemini CLI — so the old "terse, channel-pasteable" constraint is **retired**: prefer
> a clear scannable table, and on Desktop offer to render large/shareable results as an **artifact**.
> Consumers of the same gateway tools also include M2M callers and the Maya/HEBA agents; keep the
> tool-call logic here thin so the gateway/IDL stays the single source of truth.

## Tools this skill uses (all read-only, via the gateway connector)

- `safe_sql_sandbox` — parameterised read-only AlloyDB SQL (the workhorse for every branch).
- `safe_cypher_sandbox` — read-only Neo4j Cypher for the proven-vs-stated graph cross-check.
- `search_internal_knowledge` — Vertex AI Search over the **WhatsApp** conversation corpus (Branch-F).
- `analyze_identity_graph` — resolve a partner phone/email to its identity subgraph (Branch-C).
- `get_ticket_360` — pull a cited Zendesk thread if the user drills into one.

**Source-honesty rule:** semantic conversation search is **WhatsApp ONLY**. Do not claim to
semantically search Slack/Zendesk. When you cite corpus data, disclose the corpus/data window.

## Always open with scope + the anti-hallucination preamble (FU-3)

Before any ranking, state, in one or two lines:

- **Data scope + as-of.** e.g. "supplierCapabilityIndex — ~969 partners across ~8,700 products,
  2022-08 → present." (Confirm the live window with a quick `MIN/MAX("lastSeenAt")` if precision
  matters.)
- **What "ranking" means.** "I rank by **count of proven past orders**, not a reliability score — no
  reliability table exists (`supplierCommercialTerms` is empty)."
- **Parsed constraints + exclusions** (below), echoed back so the user can correct them.

Never fabricate a per-partner breakdown you did not query. For off-network suppliers (Branch-F) never
report order counts — there are none; cite only conversation evidence.

## Step 1 — Parse the request (constraints + excluded vendors)

Real requests are terse and multi-constraint. Extract:

- **product / SKU / category / partner-name / order-# / event-#** (routes to a branch below).
- **date · city · venue · quantity/spec · urgency** — echo these; most are NOT structurally filterable
  (no forward-availability, no pax/venue model) — say so rather than pretend to filter.
- **excludeVendors[]** — the load-bearing one. Pull names introduced by `denied`, `already tried`,
  `awaiting`, `quoted`, `not available`, `apart from`, `except`, `other than`. Fuzzy-match each to
  `Partners.tradeName`/`legalName` (terse "Fern" → "Fern Event Rentals"); if a token is ambiguous,
  **confirm the match** rather than over-exclude. Apply as `NOT ILIKE ALL (...)` on every ranking query.

## Step 2 — Route to a branch

| The user gave…          | Branch                                                |
| ----------------------- | ----------------------------------------------------- |
| product / SKU           | **A** (catalog) run together with **A-gen** (generic) |
| category                | **B**                                                 |
| partner name + a fact   | **C**                                                 |
| Order # / Event #       | **D**                                                 |
| "top N" / "reliable"    | **E**                                                 |
| "invisible" / 0 results | **F** (pre-registration corpus)                       |

Branch-A's 0-row path auto-cascades **A → A-gen → F** — never leave the user at a bare "no results".

### Branch-A — catalog product (`safe_sql_sandbox`)

```sql
SELECT "partnerName",
       STRING_AGG(DISTINCT "productName", ', ' ORDER BY "productName") AS "variants",
       SUM("totalOrders") AS "ordersFulfilled",
       SUM("totalQuantity") AS "totalQty",
       ROUND(AVG("avgPriceFils")/100.0, 0) AS "avgPriceAED",
       MAX("lastSeenAt") AS "lastSeen"
FROM intelligence."supplierCapabilityIndex"
WHERE "productName" ILIKE '%' || :term || '%'
  AND "totalOrders" > 0                         -- proven only
  AND "partnerName" NOT ILIKE '%assign%'        -- drop TBA (has real orders, so name-filter it)
  AND "partnerName" NOT ILIKE '%NOT TO BE USED%'
  AND "partnerName" NOT ILIKE '%do not use%'
  -- AND "partnerName" NOT ILIKE ALL (:excludeVendorPatterns)   -- when excludeVendors present
GROUP BY "partnerName"
ORDER BY "ordersFulfilled" DESC
LIMIT 25;
```

Rank by `ordersFulfilled` desc. Cite `tradeName` + offer `drill N` → the last 5 `orderNumber`s.

### Branch-A-gen — generic `--Name--` path (co-primary, run alongside A for product terms)

Generic umbrella products (`--Ice Cream Station--`, `--Generator--`, `--Birthday Decor--`) are ~33% of
orders / ~55% of GMV — they are found through order line items, not the catalog name.

```sql
SELECT pt."tradeName" AS "partnerName",
       COUNT(DISTINCT oi.id) AS "lineItems",
       COUNT(DISTINCT o.id)  AS "orders",
       STRING_AGG(DISTINCT p.name, ', ') AS "catalogNames"
FROM "haflaCore"."OrderItems" oi
JOIN "haflaCore"."Products" p            ON p.id = oi."entityId"       -- entityType always 'Product'
JOIN "haflaCore"."Orders" o              ON o.id = oi."orderId"
JOIN "haflaCore"."OrderItemPartners" oip ON oip."orderItemId" = oi.id
JOIN "haflaCore"."Partners" pt           ON pt.id = oip."partnerId"
WHERE p.name ILIKE '%' || :term || '%'
  AND pt."tradeName" NOT ILIKE '%assign%'
  -- AND pt."tradeName" NOT ILIKE ALL (:excludeVendorPatterns)
GROUP BY pt."tradeName"
ORDER BY "orders" DESC
LIMIT 25;
```

For the negotiated spec ("the gold"), pull `OrderItems.productNotes` for the matched generic rows.
**`productNotes` is Slate JSON** — `[{ "type":"paragraph", "children":[{ "text":"..." }] }]` — extract
`.children[].text`, do NOT read it as a plain string.

### Branch-B — category · Branch-C — partner fact · Branch-D — order#

- **B:** same shape as A but `WHERE "categoryName" ILIKE '%'||:cat||'%'`, `HAVING SUM("totalOrders") >= 5`.
- **C:** single-row `haflaCore.Partners` (tradeName/legalName ILIKE). `address` is mostly NULL and
  `cityId` ~41% populated — say **"no verified warehouse address"** rather than guess. Phone/email
  instead of a name → `analyze_identity_graph`.
- **D:** `Orders → OrderItems → OrderItemPartners → Partners WHERE o."orderNumber" = :n::integer`.

### Branch-E — top-N ranked, with optional proven-vs-stated graph split

SQL aggregate as Branch-B with a recency window (`lastSeenAt > NOW() - INTERVAL ':m months'`) and
`HAVING SUM("totalOrders") >= :minOrders`. For "reliable X", state the proxy honestly (proven count +
recency) and the gap (no reliability table). On "proven vs just listed?", run the graph cross-check:

```cypher
// proven fulfilment — the trustworthy signal (33,846 edges)
MATCH (oi:ORDER_ITEM)-[:FOR_PRODUCT]->(pr:PRODUCT)
WHERE pr.name CONTAINS $term
MATCH (oi)-[:FULFILLED_BY]->(p:PARTNER)
RETURN p.tradeName AS partner, count(DISTINCT oi) AS provenItems
ORDER BY provenItems DESC LIMIT 10;
// stated capability — weaker / noisier (27,280 edges)
MATCH (p:PARTNER)-[:CAN_SUPPLY]->(pr:PRODUCT)
WHERE pr.name CONTAINS $term
RETURN p.tradeName AS partner, count(DISTINCT pr) AS statedProducts
ORDER BY statedProducts DESC LIMIT 10;
```

Edge names/direction are exact: `(ORDER_ITEM)-[:FULFILLED_BY]->(PARTNER)` for proven,
`(PARTNER)-[:CAN_SUPPLY]->(PRODUCT)` for stated. Use literal `LIMIT 10` in the query text (parameterised
ints need `neo4j.int()`; literals avoid the float-coercion trap).

### Branch-F — the "invisible" supply chain (`search_internal_knowledge` + `safe_sql_sandbox`)

1. `search_internal_knowledge("<product> supplier vendor pricing <city?>")`.
2. Candidate partner names = enriched `partnerNames[]` ∪ brand parsed from each chat `title`.
3. For each candidate: `SELECT count(*) FROM "haflaCore"."Partners" WHERE "tradeName" ILIKE '%cand%' OR "legalName" ILIKE '%cand%'`.
4. Partition: **registered** (count>0, surfaced via conversation) vs **★ invisible** (count=0 — a
   supplier the team has talked to but never registered).
5. Cite chat title + date window (+ GCS link if present). **No fabricated order counts** for invisible
   suppliers.

## Ranking & filtering rules (apply everywhere)

- **Proven first.** Rank by real past orders (`totalOrders` / `FULFILLED_BY`). Stated capability
  (`CAN_SUPPLY`, zero-order SCI rows) is a weaker "also listed" signal — ~62% of SCI rows are
  zero-order; never present them as proven.
- **Filter placeholders by name, not just `totalOrders>0`.** `To Be Assigned (TBA)` and
  `… NOT TO BE USED …` / `do not use` partners have real orders — exclude by name pattern.
- **Tag, don't hide, internal logistics.** "Hafla Delivery" surfaces as a top "supplier" but is
  internal logistics — flag it as such, don't drop it silently.
- **Exclude the user's denied/tried vendors** on every query.

## Output (Claude Desktop)

Every reply: **(1)** scope + FU-3 preamble + parsed constraints + exclusions → **(2)** proven-orders
ranked table citing `tradeName` (never UUIDs) → **(3)** the ★ invisible-supplier flag when relevant →
**(4)** honest caveats + a `drill N` → last-5-`orderNumber` offer.

- Keep it scannable. For a **large or shareable** shortlist (≳8 rows, or when the user wants to
  save/compare/forward), offer to render it as a **Claude artifact** (a supplier shortlist table).
- **Citations:** partner `tradeName` + integer `Orders.orderNumber` only. Never surface product/partner
  UUIDs — they fail the "verify against WATI/ZD" intent.

## Guardrails

- **Read-only.** Never create/book/register anything (no write tools exist). Branch-F only _flags_
  invisible suppliers for the supply team.
- **No reliability score.** Approximate with proven-order count + recency; state the gap.
- **No forward availability.** Only historical fulfilment — say so; don't imply you confirmed a date.
- **Routes out:** product "101"/knowledge brief → `product-brief`; pricing distribution / cheapest-X /
  margin → `pricing-lookup`; host → their past orders → `past-orders`.

## Forward note (migration — do not silently rewrite)

These branches hand-write SQL against `supplierCapabilityIndex` / `haflaCore` because that is what the
live gateway exposes today. Two changes in flight make this thinner:

- **IDL views (PR #319, deploy pending):** `intelligence.supplierCapabilitySummary` (partner-level
  proven-vs-stated rollup) and `intelligence.productPriceBands` (per-product cost band, custom items
  excluded) are the intended backing — prefer them over re-aggregating SCI once they are live.
- **Gateway `supplier_discovery` tool (PR #320):** encapsulates much of Branch-A/A-gen/E server-side.
  When it is deployed, call it instead of the raw SQL, and keep this skill to input-parsing
  (exclusion list, constraints), the corpus/invisible branch, and formatting.

Until then, the SQL above is the working path. Verify the exact enterprise install/connector flow on
Claude Desktop before wide distribution (see the plugin README).
