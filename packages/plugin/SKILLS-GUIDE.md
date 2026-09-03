# Which EvWA skill do I use?

A plain-English guide for Sales / CX / supply. Just ask your question naturally — Claude picks the
skill. This is the map of what each one answers. Everything is **read-only** and answers are **cited by
real order / event / ticket numbers**.

## Pick by what you're asking

| If you're asking… | Skill | Example |
| ----------------- | ----- | ------- |
| **Who can supply / provide X?** (rank vendors by proven orders) | `supplier-discovery` | "Who supplies chiavari chairs?" · "Top partners for LED walls, not [vendor we tried]" |
| **What does X cost / what did we pay?** (real prices, per-unit, delivered) | `pricing-lookup` | "What do we charge for a banquet chair?" · "Dry-hire cost for 100 chairs + 20 tables delivered to Business Bay" |
| **Give me a 101 / brief on X** (one product/service, all angles) | `product-brief` | "Brief me on misters" · "101 on arabic calligraphy" |
| **What did we do for X before?** (a host, company, event, order, ticket) | `past-orders` | "Past events for AUS" · "History for +9715…" · "What was on order #16504?" |
| **Where do events like this happen?** (venue *evidence*, not a recommender) | `venue-recommendation` | "Where do 200-pax outdoor events happen?" |
| **What do I need for a [event]?** (planning checklist + typical spend) | `event-needs` | "What do I need for a wedding?" (the skill maps everyday words to the playbook's family names — e.g. wedding → "Wedding and Engagement") · "Checklist for an industry conference" |

## Starter prompts (copy-paste)

Real questions to try, grouped by skill and roughly ordered by how often the team asks them. Just paste
one — Claude picks the skill and cites real order / event / partner numbers. Every prompt here was run
live against the gateway and returns a cited, non-empty answer (last verified 3 Sep 2026); a ⚠ marks a
deliberately *hard* one that exercises an honesty rule.

**`supplier-discovery` — "who can supply X?"**

- `Who supplies chiavari chairs?` → partners ranked by proven orders, with supplier→Hafla cost per tier.
- `Top partners for LED walls, not Teddy Events` → same, with a named vendor excluded from the shortlist.
- `Who can provide confetti blasters? Scout the market if we're thin.` → ranks the few internal
  suppliers and flags that market-scouting is advised (only ~5 viable).
- `Give me a dossier on Al Jefoon — proven vs just-listed products.` → one partner's capability profile
  (proven vs stated categories, order volume, top products with cost).

**`product-brief` — "give me a 101 on X"**

- `101 on banquet chairs` → catalog match + what we actually order + proven suppliers + price band + recent orders.
- `What do we know about confetti blasters?` → the same one-page brief for a thinner-history item.
- ⚠ `Brief me on arabic calligraphy` → a thin-catalog service: the brief falls back to proven-fulfilment
  evidence (a real supplier with orders) instead of reporting "nothing found" — shows the coverage-floor rule.

**`pricing-lookup` — "what does X cost / what did we pay?"**

- `What did we pay suppliers for a White Chiavari Chair?` → partner-cost anchor (~10 AED, ORDER tier) with
  the p25–p75 band — and it will *not* quote the raw 1,260 AED outlier as a price.
- `What do we charge clients for a banquet chair?` → the selling-price side (kept separate from cost).
- ⚠ `Dry-hire cost for 100 chairs + 20 tables delivered to Business Bay` → a generic/dry-hire brief:
  the per-unit numbers come from order notes + chat (not a price column), plus an optional delivery total.

**`past-orders` — "what did we do for X before?"**

- `Past events for AUS` → a corporate buyer's full event history (~129 events), deduped, newest first,
  with every AED value labelled a pre-sale estimate.
- `What was on order #28487?` → that order's line items, quantities, and fulfilling partners.
- `Which orders did Al Jefoon fulfil recently?` → a partner's recent fulfilled orders, cited by order #.

**`venue-recommendation` — "where do events like this happen?"**

- `Where do 200-pax outdoor events happen?` → the site-type mix past events used + recurring named
  venues (cited by event #) — evidence, not a recommendation.
- `What venues do corporate galas of ~150 guests use?` → the same evidence lens for a smaller band.

**`event-needs` — "what do I need for a <event>?"**

- `What do I need for a wedding?` → the ideal planning checklist (core/common/optional, ★ often-forgotten)
  paired with what Hafla actually books for weddings. (The skill maps "wedding" → the exact family name.)
- `Checklist for an industry conference` → the corporate playbook: budget band, per-guest cost, and what
  Hafla should pitch.
- `What do we actually sell for birthdays?` → category attach-rates + median selling price, from ~6,300
  real birthday orders.

## Good to know (the honesty rules)

- **Cost vs price:** partner **cost** (what a supplier charges Hafla) is never shown as a client price,
  and vice-versa — each number is labelled.
- **Conversation search is WhatsApp-only.** We can pull structured Zendesk/Slack data, but "semantic
  search of what people said" is WhatsApp corpus only — and the answer tells you its as-of date.
- **Proven vs stated:** suppliers are ranked by **real past orders**, not a reliability score (none
  exists) — listed-but-never-delivered vendors are labelled as such.
- **Estimates are labelled.** Some figures (e.g. a company's per-event `valueAed`) are pre-sale
  *estimates*, not realized totals — the answer says so.
- **What it won't do:** book/create/register anything (read-only); quote a margin/markup (out of scope);
  invent numbers it doesn't have.

## Where it runs

- **Claude Code:** installed as a plugin — invoke with `/evwa-intelligence:<skill>` or just ask.
- **Claude Desktop:** per-user skill install + the EvWA connector — see
  [`DESKTOP-SETUP.md`](DESKTOP-SETUP.md) (rolling out with OAuth Stage 2).

Needs the EvWA gateway connected. Questions → your team channel.
