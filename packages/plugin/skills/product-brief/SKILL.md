---
name: product-brief
description: >-
  Build a one-page Hafla-context brief ("101") on any product, service, or concept — catalog match,
  what was actually ordered (negotiated spec from order notes), proven suppliers, a price band, recent
  cited orders, and negotiated/setup detail from WhatsApp. Use for "/101 X", "give me 101 on X", "brief
  me on X", "what do we know about X". Hafla-context-first (skips generic encyclopedia knowledge).
  Read-only, via the EvWA gateway.
---

# product-brief

Compose **one deterministic, one-page Hafla-context brief** from five sources no human can assemble in
the seconds a planner has on a thread. The value is the **composition**, not any single lookup — this
skill orchestrates the gateway tools and synthesises. Lead with Hafla's own data; **generic
encyclopedia knowledge is one line at most, skipped by default.**

> **Delivery model.** Claude Desktop (Chat/Cowork) + Claude Code, tools via the connected gateway. A
> 101-brief is a natural **artifact** — on Desktop, render the finished brief as a one-page Claude
> artifact the planner can save/share. (Old Slack-terseness/Gemini framing retired.)

## Open with scope + the run choice

"101 on '<subject>' — Hafla context first (I skip generic encyclopedia unless you ask). Data: orders
2021→present (dense from 2023). Run **[1] DB-only** (fast) or **[2] DB + WhatsApp conversations**
(slower, adds negotiated detail + setup gotchas)?"

## The five sources (compose them; cite as you go)

1. **Catalog match** — `product_lookup({ id|slug|productNumber })` if you have an id, else
   `catalog_search({ query: "<subject>" })` to resolve **named** SKU(s). **`catalog_search` EXCLUDES
   generic `--Name--` products** (it filters `btrim(name) NOT LIKE '--%--'`), so to detect/resolve a
   generic run a raw query: `safe_sql_sandbox` → `SELECT id, name FROM "haflaCore"."Products" WHERE name
   ILIKE '%'||:term||'%' AND name LIKE '--%--'`. If the subject is generic (`--…--`) it's the dominant
   grain (55% of GMV) — sources 2/5 carry the real detail, and `price_truth` will return
   `BLOCKED_GENERIC` (say so instead of quoting a catalog price).
2. **What was actually ordered** — the negotiated spec/price in `OrderItems.productNotes` /
   `priceNotes` (raw `safe_sql_sandbox`; **Slate JSON** → flatten `.children[].text`, don't dump
   markup). Cite `Orders.orderNumber` (integer).

   ```sql
   SELECT o."orderNumber", pt."tradeName" AS "partner", oi."productNotes", oi."priceNotes"
   FROM "haflaCore"."OrderItems" oi
   JOIN "haflaCore"."Products" p ON p.id = oi."entityId"
   JOIN "haflaCore"."Orders"   o ON o.id = oi."orderId"
   LEFT JOIN "haflaCore"."OrderItemPartners" oip ON oip."orderItemId" = oi.id
   LEFT JOIN "haflaCore"."Partners" pt ON pt.id = oip."partnerId"
   WHERE p.name ILIKE '%'||:term||'%' AND (oi."productNotes" IS NOT NULL OR oi."priceNotes" IS NOT NULL)
   ORDER BY o."orderNumber" DESC LIMIT 8;
   ```

3. **Proven suppliers** — `supplier_discovery({ product: "<subject>" })` → `delivered[]` (proven by
   real orders; costs/recency; `bespokeJobs`/`supersededRecord` flags). Prefer the tool, but it has a
   **coverage floor for thin-volume / service-type products** (verified: `calligraphy` → `delivered:[]`
   despite partner *Tariq* having 16 real orders). **If `delivered` is empty, fall back to the raw
   `FULFILLED_BY` grain** (`safe_cypher_sandbox`, or the `Products→OrderItems→OrderItemPartners→Partners`
   SQL) before writing "no proven supplier" — do not treat an empty tool result as ground truth.
4. **Price band** — `price_truth({ id: <uuid> })` for the **selling** band (p25/median/p75,
   reliable/committable); if the caller wants **cost**, `price_anchor({ productId: <uuid> })` (tier-aware
   partner-cost anchor + band, ORDER-preferred). Label selling vs cost. (`price_truth` blocks generics →
   for a `--…--` subject, the price lives in source 2/5, say so.)
5. **WhatsApp negotiated detail + setup gotchas** (only on run choice [2]) —
   `search_internal_knowledge({ query: "<subject> setup pricing supplier" })`. Corpus = **WhatsApp only**; disclose
   the date (`waCorpusGeneration.lastSyncAt` via `get_data_freshness`); cite chat title. Pull recurring
   setup challenges + partner mentions.

Optional: `related_products({ id })` for "commonly ordered with" (a useful brief line), and
`get_ticket_360({ ticket_id: "<n>" })` if the user drills into a cited Zendesk ticket.

## Brief structure (the one page)

1. **What it is** (1–2 lines, Hafla-context; ≤1 line generic knowledge, only if it adds).
2. **What we actually order** — negotiated spec highlights from `productNotes`, with 2–3 cited
   `orderNumber`s.
3. **Price band** — selling median/IQR (+ cost if asked), tier-labelled; note generic caveat.
4. **Proven suppliers** — top 3–5 from `supplier_discovery.delivered[]` (tradeName, orders, recency).
5. **Recent orders** — 5 most recent, cited by `orderNumber` (+ `userEventNumber` if relevant).
6. **[if run 2] Negotiated/setup notes** — recurring gotchas + vendor mentions from the corpus.
7. **Data window + confidence** stated honestly; **scope-widen offer**.

## Guardrails / routes out

- **Hafla-context-first.** Do not pad with generic encyclopedia knowledge (a planner rejected general
  info on calligraphy) — one line max, only if it helps.
- Cite `Orders.orderNumber` / `UserEvents.userEventNumber` / partner `tradeName` — **never UUIDs**.
- **Margin / markup / profit is OUT OF SCOPE (wave-2 commercial-intelligence).** The brief puts selling
  (`price_truth`) and cost (`price_anchor`) on one page, so it's a real temptation — do **not** compute
  or present `selling − cost`, markup %, or margin. Deflect: "margin is wave-2 commercial-intelligence."
  (Matches `pricing-lookup` / `supplier-discovery` / `venue-recommendation`.)
- Read-only. Deep host order history → `past-orders`; price distribution deep-dive → `pricing-lookup`;
  "who can supply / who else" → `supplier-discovery`; where/venue evidence for a pax band →
  `venue-recommendation`.
- State the real data window and confidence; don't imply completeness the sources don't have.

## Forward note

Now largely **tool-first**: sources 1/3/4/optional are `product_lookup`/`catalog_search`,
`supplier_discovery` (+ `supplier_brief` for a single-partner deep dive), `price_truth`/`price_anchor`,
`related_products`. Only source 2 (`productNotes`/`priceNotes`) stays raw (no tool yet). A future
generic/notes tool would make this fully tool-first. Verify the enterprise install/connector flow on
Claude Desktop before wide distribution (see the plugin README).
