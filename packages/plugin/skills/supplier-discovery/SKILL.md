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
skill is **thin**: the gateway's `supplier_discovery` tool does the heavy ranking server-side; the
skill owns input-parsing, the branches the tool defers (partner facts, order lookups, the
WhatsApp/"invisible" branch, the proven-vs-stated graph cross-check), and the honest framing.

> **Delivery model.** Targets **Claude Desktop (Chat/Cowork)** + Claude Code, tools via the connected
> EvWA gateway (MCP). Not a Slack bot, not Gemini CLI — prefer a clear scannable table, and on Desktop
> offer to render large/shareable results as an **artifact**. The same gateway tools also back M2M and
> the Maya/HEBA agents, so keep logic thin — the gateway/IDL is the source of truth.

## Primary tool — `supplier_discovery`

Call it first for any "who supplies / top suppliers for X" question:

```
supplier_discovery({ product: "<product or category>", limit: 8 })   // limit optional, max 20
```

It returns three sections (interpret them precisely — field shapes matter):

- **`delivered[]`** — partners matched to the product/category, one row per partner. Fields:
  `partner` (tradeName), `products`/`productCount` (matched real variants), `bespokeJobs` (custom
  `--…--` jobs — capability signal, no unit price), **`orders`** (summed `totalOrders` — **can be `0`
  or `null`**), `costAed` — an **object `{ avg, min, max }` in AED** (**supplier→Hafla cost, never a
  client price**), or `null` for a bespoke-only partner — plus `costBasis` (a words string, e.g. "N
  observations from confirmed orders"), `lastWorkedWith`, `active`, contacts `phone` / `hasWhatsapp` /
  `email` (already dummy-filtered by the tool) / `contactPerson` (internal use — D-9), and
  `supersededRecord` (**an old VAT-record rename — supplier is fine, that record is retired, never book
  it**). Sorted recency-then-orders; TBA/placeholder filtered.
  - **PROVEN vs STATED (important):** the tool does **not** filter `orders > 0`, so `delivered[]` can
    include stated-only listings (`orders` = 0/null, no proven fulfilment). **Rank/lead with `orders >
    0` rows as "proven"; label `orders` 0/null rows as "listed, not yet delivered".** Do not call the
    whole list "proven".
- **`plannerNotes[]`** — internal Zendesk notes mentioning the product alongside supplier/vendor/price
  (new vendors, competitor quotes, responsiveness). Automation/digests already stripped.
- **`marketScout`** — `{ advised, viableInternal, reason }`. When `advised` is `true` (`< 6` viable
  recent+active suppliers), tell the planner to scout the open market. `advised` can also be **`null`**
  (the tool couldn't assess — e.g. a source degraded); a top-level **`degraded[]`** may list which
  source failed — surface "partial results (X unavailable)" rather than asserting a clean count.

The tool encapsulates the old catalog + generic-`--Name--` + category + top-N ranking, plus D-30
bespoke segregation and TBA/superseded handling — **do not re-implement those in SQL.**

### If the tool returns empty — DON'T report "no supplier" (proven-fulfilment fallback)

`supplier_discovery` has a **coverage floor for thin-volume / service-type products** — it can return
`delivered: []` with `marketScout.viableInternal: 0` even when real, recent fulfilment exists (verified:
`calligraphy` → empty from the tool, yet partner **Tariq** has **16** real orders, last 2026-02). So on
an empty/zero result for a product that plausibly has history, run the raw proven-fulfilment fallback
before concluding anything:

```sql
SELECT pt."tradeName", count(DISTINCT o.id) AS "orders", max(o."createdAt")::date AS "lastOrder"
FROM "haflaCore"."Products" p
JOIN "haflaCore"."OrderItems" oi         ON oi."entityId" = p.id
JOIN "haflaCore"."Orders" o              ON o.id = oi."orderId"
JOIN "haflaCore"."OrderItemPartners" oip ON oip."orderItemId" = oi.id
JOIN "haflaCore"."Partners" pt           ON pt.id = oip."partnerId"
WHERE p.name ILIKE '%'||:term||'%'
GROUP BY pt."tradeName" ORDER BY "orders" DESC LIMIT 10;
```

(or the graph `FULFILLED_BY` cross-check below). Only say "no internal supplier / scout the market" if
**both** the tool and this fallback come back empty.

## Step 1 — Parse the request (constraints + excluded vendors)

- **product / category / partner-name / order-# / event-#** (routes below).
- **date · city · venue · qty/spec · urgency** — echo them; most are NOT filterable (no
  forward-availability, no pax/venue model, `Partners.cityId` ~41% populated) — say so.
- **excludeVendors[]** — pull names after `denied`, `already tried`, `awaiting`, `quoted`,
  `not available`, `apart from`, `except`, `other than`. The tool has **no exclusion parameter**, so
  after it returns, **drop matching `delivered[]` rows client-side** (fuzzy-match on `partner`;
  confirm ambiguous tokens rather than over-exclude) and state which vendors you excluded.

## Step 2 — Route

| The user gave…                            | Path                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| product / category / "top N" / "reliable" | **`supplier_discovery` tool** (then client-filter excludeVendors) |
| partner name + a fact                     | **Branch-C** (raw SQL + `analyze_identity_graph`)                 |
| Order # / Event #                         | **Branch-D** (raw SQL) — also the drill-down target               |
| "invisible" / few viable                  | **Branch-F** (`search_internal_knowledge`, the tool defers this)  |
| "proven vs just listed?"                  | **graph cross-check** (`safe_cypher_sandbox`)                     |

### Always open with scope + the anti-hallucination note (FU-3)

Before the table: "I rank by **proven past orders** (from `supplier_discovery`), not a reliability
score — none exists. Costs shown are **supplier→Hafla**, not client prices. Data spans ~2022-08 →
present." Echo parsed constraints + exclusions. Never invent a per-partner breakdown the tool didn't
return; never report order counts for off-network (Branch-F) suppliers.

### Branch-C — partner fact (`safe_sql_sandbox` + `analyze_identity_graph`)

The tool returns contacts inline, but for "warehouse location / discount % / full contact" on one
partner:

```sql
SELECT id, "tradeName", "legalName", "emailId", "mobile", "address", "cityId",
       "pocName", "pocDesignation", "onBoardingStatus", "isActive"
FROM "haflaCore"."Partners"
WHERE "tradeName" ILIKE '%'||:partner||'%' OR "legalName" ILIKE '%'||:partner||'%'
LIMIT 5;
```

`address` is mostly NULL — say **"no verified warehouse address"**, don't guess. Some `emailId`s are
placeholders (`haflapartner+…@dummy.com`) — treat an `@dummy.` email as "no email on record", not a real
contact (the `supplier_discovery` tool filters these; this raw query does not). Phone/email instead of
a name → `analyze_identity_graph`.

### Branch-D — order # → who supplied, and drill-downs (`safe_sql_sandbox`)

The tool returns no order numbers, so for `drill <partner>` (last 5 order #s) or an explicit order #:

```sql
SELECT o."orderNumber",                              -- integer; the citation key
       p.name AS "productName", oi.quantity,
       pt."tradeName" AS "partnerName"
FROM "haflaCore"."Orders" o
JOIN "haflaCore"."OrderItems" oi          ON oi."orderId" = o.id
LEFT JOIN "haflaCore"."Products" p        ON p.id = oi."entityId"
LEFT JOIN "haflaCore"."OrderItemPartners" oip ON oip."orderItemId" = oi.id
LEFT JOIN "haflaCore"."Partners" pt       ON pt.id = oip."partnerId"
WHERE o."orderNumber" = :n::integer      -- or: pt."tradeName" ILIKE :partner ... ORDER BY o."orderNumber" DESC LIMIT 5
ORDER BY oi.id;
```

For generic `--Name--` line items, `OrderItems.productNotes` is **Slate JSON**
(`[{children:[{text}]}]`) — extract `.children[].text`, not a plain string.

### Branch-F — the "invisible" supply chain (`search_internal_knowledge` + `safe_sql_sandbox`)

The tool defers the WhatsApp corpus (`quotedInChat`, v2), so this branch is the skill's own — run it on
`invisible`/`widen` or when `marketScout.advised` is true:

1. `search_internal_knowledge({ query: "<product> supplier vendor pricing <city?>" })` (WhatsApp corpus **only**).
2. Candidates = enriched `partnerNames[]` ∪ brand parsed from each chat `title`.
3. Each candidate: `SELECT count(*) FROM "haflaCore"."Partners" WHERE "tradeName" ILIKE '%cand%' OR "legalName" ILIKE '%cand%'`.
4. Partition **registered** (count>0) vs **★ invisible** (count=0 — talked to, never registered).
5. Cite chat title + date window; **no fabricated order counts** for invisible suppliers.

### Graph cross-check — proven vs stated (`safe_cypher_sandbox`, on "proven vs just listed?")

```cypher
MATCH (oi:ORDER_ITEM)-[:FOR_PRODUCT]->(pr:PRODUCT) WHERE pr.name CONTAINS $term
MATCH (oi)-[:FULFILLED_BY]->(p:PARTNER)
RETURN p.tradeName AS partner, count(DISTINCT oi) AS provenItems ORDER BY provenItems DESC LIMIT 10;
```

`(ORDER_ITEM)-[:FULFILLED_BY]->(PARTNER)` = proven; `(PARTNER)-[:CAN_SUPPLY]->(PRODUCT)` = stated
(weaker/noisier). Use a literal `LIMIT 10` (parameterised ints need `neo4j.int()`).

## Output (Claude Desktop)

Every reply: **(1)** scope + FU-3 note + parsed constraints + exclusions → **(2)** ranked table from
`delivered[]` — `partner`, `orders`, `costAed` as a **range** (e.g. `avg (min–max) AED`, labelled
_supplier cost_), `lastWorkedWith` — **proven rows (`orders>0`) first, listed-only (`orders` 0/null)
below a divider**; flag `supersededRecord` ("retired record — don't book") and bespoke-only partners as
capability signals → **(3)** relevant `plannerNotes` (competitor quotes / new vendors) → **(4)**
`marketScout` advice when `advised` is `true` (and "partial results" when `degraded[]`/`advised:null`)
→ **(5)** ★ invisible-supplier flag (Branch-F) when run → **(6)** caveats + `drill <partner>` offer.

- Cite partner `tradeName` + integer `Orders.orderNumber`. **Never surface product/partner UUIDs.**
- Keep it scannable; for a large/shareable shortlist (≳8 rows, or "save/compare/forward"), offer a
  Claude **artifact**.

## Guardrails

- **Read-only.** Never create/book/register. Branch-F only _flags_ invisible suppliers.
- **No reliability score** — proven-order count + recency is the proxy; state the gap.
- **No forward availability** — historical fulfilment only.
- **`costAed` is supplier→Hafla cost, never a client price.** **Corpus = WhatsApp only** (not Slack/ZD).
- **Routes out:** product "101" → `product-brief`; price distribution / cheapest-X → `pricing-lookup`;
  **margin / markup → out of scope (wave-2 commercial-intelligence)**, not `pricing-lookup`; host →
  their past orders → `past-orders`; where/venue evidence for a pax band → `venue-recommendation`.

## Forward note

`supplier_discovery` is **live** (PR #320). Remaining gaps this skill still fills with raw tools:
partner-fact, order-# / drill-down, the WhatsApp "invisible" branch (tool `quotedInChat` is v2), and the
graph proven-vs-stated cross-check. When the tool gains an **exclusion parameter** and the corpus
branch, thin this skill further. **Known tool gap:** `supplier_discovery` under-covers thin-volume /
service-type products (empty `delivered[]` despite real fulfilment — see the fallback above); the fix
belongs in the tool, not this skill — until then the raw fallback is load-bearing. The tool currently
rolls up `supplierCapabilityIndex` in-handler; it could later read the IDL
`intelligence.supplierCapabilitySummary` view (PR #319) — same partner-level proven-vs-stated rollup —
for consistency. Verify the enterprise install/connector flow on Claude Desktop before wide
distribution (see the plugin README).
