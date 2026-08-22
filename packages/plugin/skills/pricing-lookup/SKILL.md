---
name: pricing-lookup
description: >-
  Look up what Hafla CHARGES or PAID for a product/service — real transacted prices (p25/median/p75)
  and the negotiated per-unit numbers buried in order notes and WhatsApp. Use for "what does X cost /
  what did we pay for X / typical or per-unit rate / dry-hire charge for N chairs + M tables". Handles
  both fully-cataloged SKUs (structured) and generic "--Name--" / dry-hire / F&B items (whose real
  price lives in notes + chat, not a price column). Read-only, via the EvWA gateway. NOT pricing
  strategy ("how should we price X") and NOT supplier discovery (route vendor questions to
  supplier-discovery).
---

# pricing-lookup

Answer "what does X cost / what did we pay / typical rate" across Hafla's **two pricing realities**.
Always separate two different numbers and label them:

- **Selling price** — what Hafla CHARGES the client (`price_truth`, from `unitSellingPrice`).
- **Partner cost** — what Hafla PAID the supplier (`productPriceBands` / `supplier_discovery.costAed`,
  from partner cost). Never present a cost as a client price or vice-versa.

> **Delivery model.** Claude Desktop (Chat/Cowork) + Claude Code, tools via the connected gateway.
> Not a Slack bot / not Gemini — prefer a clear table, offer a Claude **artifact** for a multi-item
> price sheet. The Slack-terseness constraint is retired.

## The two realities (classify each requested product first)

1. **Cataloged SKU** (a real product, not `--…--`): structured prices exist → **tool-first**.
2. **Generic `--Name--` / dry-hire / F&B** (`--Buffet--`, `--Furniture--`, `--Artist--`, dry-hire
   chairs/tables) — **~55% of GMV**. No clean per-unit price column; the negotiated number lives in
   `OrderItems.productNotes` / `priceNotes` JSONB and the WhatsApp corpus → **raw tools** (the
   `price_truth` tool BLOCKS generics on purpose). This is the primary revenue path — treat it as
   first-class, not a fallback.

## Step 1 — Parse the request

- **Identifier?** Order# / Event# / Ticket# → direct lookup (Branch-I).
- **Terse multi-constraint brief** ("12× chairs, 4× tables, vendor Fern, 4 April, Meadows"): parse
  `items[]=[{qty,name}]`, date, location, pax/duration, and **vendorsTried[]** (`Vendor: X` / "X, Y
  denied"). Echo the parse back. **Hand the vendor side to `supplier-discovery`**; keep only the
  pricing side here. Flag already-tried vendors, don't re-surface them as fresh options.

## Step 2 — Cataloged SKU → tool-first

1. **Resolve name → product UUID** with `catalog_search({ query: "<term>" })` (or `product_lookup` if you already
   have an id/slug/productNumber). If several match, confirm which SKU.
2. **Selling price:** `price_truth({ id: <uuid> })`. Read `source`:
   - `ORDER_HISTORY` → p25/median/p75 AED with the order count. If **`reliable`** (≥3 orders) state the
     p25–p75 range; if **`committable`** (a Quote/RFQ product with a tight, well-sampled spread) you may
     quote the **median as a firm price** — otherwise give the range, not a point.
   - `CATALOG_PRICE` → list price only (no order history — ~71% of products hit this); label it
     clearly as a list price, not a transacted one.
   - `BLOCKED_GENERIC` → it's a generic; go to Step 3.
3. **Partner cost** (only if asked "what did we pay"): **tool-first — `price_anchor({ id: <uuid> })`.**
   Returns `anchorAed` (tier-aware: ORDER→CART→CATALOG, real transacted cost beats list), a `band`
   (min/p25/median/p75/max), `tier`+`confidence`, `provenance` (obs / partner counts), and per-partner
   `observations` — the `productPriceBands` rollup wrapped, plus the partner breakdown. Pass `partnerId`
   to narrow to one supplier. Lead with `anchorAed` + `tier`. This is **partner cost**, label it so.
   *(Raw fallback only if you need a column the tool omits, or to cross-check a recent-tool result:
   `SELECT "representativeMedianFils"/100.0 AS "repMedianAed", "representativeTier", … FROM
   intelligence."productPriceBands" WHERE "productId" = :uuid;`)*

## Step 3 — Generic `--Name--` → raw tools (the gold; price_truth blocks these)

1. **Order-note evidence** (`safe_sql_sandbox`): the negotiated spec + per-unit number planners wrote in:

   ```sql
   SELECT o."orderNumber", pt."tradeName" AS "partner",
          oi."productNotes", oi."priceNotes"          -- BOTH are Slate JSON
   FROM "haflaCore"."OrderItems" oi
   JOIN "haflaCore"."Products" p ON p.id = oi."entityId"
   JOIN "haflaCore"."Orders"   o ON o.id = oi."orderId"
   LEFT JOIN "haflaCore"."OrderItemPartners" oip ON oip."orderItemId" = oi.id
   LEFT JOIN "haflaCore"."Partners" pt ON pt.id = oip."partnerId"
   WHERE p.name LIKE '--%--' AND p.name ILIKE '%'||:term||'%'
     AND (oi."productNotes" IS NOT NULL OR oi."priceNotes" IS NOT NULL)
   ORDER BY o."orderNumber" DESC LIMIT 15;
   ```

   `productNotes`/`priceNotes` are **Slate JSON** (`[{children:[{text}]}]`) — flatten `.children[].text`
   before showing; do NOT dump raw markup. ILIKE on `::text` matches for searching.

2. **WhatsApp negotiated quotes** (`search_internal_knowledge`): the corpus often holds the ONLY
   per-unit number ("Banquet Rectangle Table AED 60/pc/day"). Corpus = **WhatsApp only**; disclose the
   date. Cite chat title + date.
3. **CATALOG/`ProductPartner` price is a trap for generics** ("fooling the system") — do not present it
   as the negotiated price.

## Confidence & honesty rules

- Structured tiers: **ORDER 0.90 · CART 0.85** are trustworthy; **CATALOG 0.70 is OFF by default**
  (template/list price, not transacted). Say which tier a number came from.
- **Lead with median**, not mean (bundle rows skew the mean).
- Refuse a bare "average" for a generic until you've shown the notes/corpus grain — a single pooled
  number across bundled line items is misleading.
- **Citations are path-dependent:** on the **generic/raw path (Step 3)** cite `Orders.orderNumber`
  (integer) — individual orders exist there. On the **cataloged tool path (Step 2)**, `price_truth`
  returns only aggregates (p25/median/p75 + `orderCount`) with **no order numbers to cite** — ground the
  figure with the **order count + source tier**, and offer a raw drill-down for the individual #s.
  **Never surface UUIDs.**

## Output (Claude Desktop)

Coverage line (how many observations / order count, window) → the number(s) with **selling vs cost
labelled** and the tier → **grounding**: raw/generic path → cite the `orderNumber`s; tool path → cite
the `orderCount` + tier (no per-order #s exist — offer a raw drill-down to list them) → denial list
honoured → drill-down offer (all order #s · per-partner · per-month trend · full notes for top N ·
widen to corpus). For a multi-item brief, offer a Claude **artifact** price sheet (one row per item:
qty, selling median, cost median, tier, n).

## Guardrails / routes out

- Read-only. **Not pricing strategy** ("how should we price X" — out of scope). **Not supplier
  discovery** — "who can supply / who else" → `supplier-discovery`. Product "101" → `product-brief`;
  where/venue evidence → `venue-recommendation`.
- **Margin / markup / profit is OUT OF SCOPE (wave-2 commercial-intelligence).** Selling and cost both
  appear here, so it is a real temptation — do **not** compute or present `selling − cost`, markup %, or
  margin, even when a caller (or `supplier-discovery`) arrives asking for it. Deflect: "margin is wave-2
  commercial-intelligence." (Consistent with the README + `venue-recommendation`.)
- No forward guarantees — historical transacted prices only.

## Forward note

Cataloged-SKU pricing is **tool-backed both ways**: `price_truth` (selling) + `price_anchor` (cost —
wraps `productPriceBands`, tier-aware; shipped 2026-08-22). Only the generic `--Name--` path
(`productNotes`/`priceNotes` + corpus) has **no tool yet** — it stays raw here; a future `generic_price`
/ corpus-pricing tool would close that. `price_anchor` is recent — prefer it, but the raw
`productPriceBands` query is the documented fallback if an output looks off. Coordinate tier labels with
`product-brief` (both surface ORDER/CART/CATALOG tiers); `supplier-discovery` uses its own `costBasis`
wording, not these tiers.
