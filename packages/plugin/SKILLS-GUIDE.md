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
