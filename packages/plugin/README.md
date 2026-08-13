# EvWA Intelligence — plugin (wave-1 skills)

Agent **skills** that sit on top of the read-only EvWA Intelligence gateway (`mcp.hafla.com`) and turn
"who supplies X / what did we pay / 101 on X" questions into governed, cited answers — for Hafla's
Sales / CX / supply team.

## Delivery model (2026-08-13 correction — read this before building more)

The original wave-1 plan targeted a Claude Code + Gemini CLI dual-manifest plugin whose output was terse
and channel-pasteable for a future Slack bot. **That premise is retired.** The corrected model:

- **Primary surface: Claude Desktop (enterprise) — Chat / Cowork.** Most of the team lives here; many
  never open Claude Code. Skills authored as portable `SKILL.md` also load in Claude Code and via the API.
- **Output: artifacts are first-class.** No Slack-terseness constraint — prefer a clear scannable table,
  and offer a Claude **artifact** for large/shareable results.
- **Tools: the gateway is an MCP connector.** Skills call the gateway's read-only tools through the
  connected server; they add no new gateway code.
- **No Slack bot.** Demand-side embedding is handled by the Maya / HEBA agents (which consume the same
  gateway tools); these skills are the internal-team analytical surface.
- **Google path (Gemini CLI / Antigravity) parked.** No `gemini-extension.json` in wave 1.

Full rationale: `hafla-intelligence/mcp-gateway/specs/history-and-future/history/research/intelligence-gateway/skills-wave-1/2026-08-13-delivery-model-correction.md`.

## Wave-1 skills (build order)

| #   | Skill                  | Status                              |
| --- | ---------------------- | ----------------------------------- |
| 1   | `supplier-discovery`   | **built (tool-first)**              |
| 2   | `pricing-lookup`       | **built (tool-first)**              |
| 3   | `product-brief`        | **built (tool-first orchestrator)** |
| 4   | `past-orders`          | **built (tool-first)**              |
| 5   | `venue-recommendation` | **built (evidence-only)**           |

Design specs live in the sibling repo:
`hafla-intelligence/mcp-gateway/specs/history-and-future/history/research/intelligence-gateway/skills-wave-1/`
(`00-shared-context.md` + one `proposal-<skill>.md` each).

## Layout

```
packages/plugin/
  README.md                              # this file
  skills/
    supplier-discovery/SKILL.md          # who supplies X (tool-first)
    pricing-lookup/SKILL.md              # what we charge / paid (selling vs cost)
    product-brief/SKILL.md               # the 5-source "101" (orchestrator)
    past-orders/SKILL.md                 # history for a host/partner/order/event
    venue-recommendation/SKILL.md        # evidence-only venue lookup
```

Each skill is a portable `SKILL.md` (YAML frontmatter `name` + `description`, then instructions). The
`description` is what the host uses to decide when to invoke the skill, so it names the trigger phrases.

## Conventions every skill follows

- **Cite human-readable integer keys** — `Orders.orderNumber`, `UserEvents.userEventNumber`, Zendesk
  ticket #, partner `tradeName`. **Never surface product/partner UUIDs.**
- **Source-honesty** — semantic conversation search (`search_internal_knowledge`) is **WhatsApp only**;
  never claim to semantically search Slack/Zendesk. Disclose the data/corpus window.
- **Read-only** — no create/book/register (the gateway exposes no write tools).
- **Money labels** — partner `costAed` (supplier→Hafla) is never a client price; selling price is never
  a cost. Label which one a number is.
- **Route out** — supply → `supplier-discovery`, price → `pricing-lookup`, 101 → `product-brief`,
  history → `past-orders`, venue evidence → `venue-recommendation`; pricing _strategy_ and _margin_ are
  out of scope (wave-2 commercial intelligence).

## Prerequisites (to run a skill)

1. The EvWA Intelligence gateway added as a **connector** in Claude Desktop (the read-only MCP server at
   `mcp.hafla.com`), so the tools (`safe_sql_sandbox`, `safe_cypher_sandbox`,
   `search_internal_knowledge`, `analyze_identity_graph`, `get_ticket_360`, plus the R1–R5 tools) are
   available in Chat / Cowork.
2. The skill installed on the surface (Claude Desktop via Customize/Capabilities, or Claude Code).

## Open items (verify before wide distribution)

- **Enterprise Agent-Skill distribution on Claude Desktop** — confirm the admin flow for pushing a skill
  folder to the org (flagged in the delivery-model correction).
- **Connector availability** — confirm which org connector exposes the gateway tools in Chat / Cowork
  (the old "Ask Hafla" pin is obsolete).
- **Tool migration — DONE.** PR #314/#316/#317/#319/#320 deployed 2026-08-14. All 5 skills are
  tool-first where a tool exists: `supplier-discovery` → `supplier_discovery`; `pricing-lookup` →
  `price_truth` (selling) + `productPriceBands` (cost); `product-brief` → `product_lookup` /
  `supplier_discovery` / `price_truth` / `related_products`; `past-orders` → `analyze_identity_graph` /
  `get_ticket_360` / `get_lead_context` / `customer_360`. Remaining raw-SQL grains (generic `--Name--`
  price, per-host order enumeration, venue evidence) have no tool yet — noted in each SKILL.md's
  forward note as future tool candidates.

## Status

Wave-1 is **built** (all 5 skills) and **schema-verified** against the live gateway — 18 tools +
`productPriceBands`/`supplierCapabilitySummary` deployed 2026-08-14, every tool-call shape and every raw
SQL column checked against the deployed schema. Not yet **installed/run** on an enterprise Claude
Desktop: that end-to-end validation (skill → connector → gateway) plus the Agent-Skill distribution flow
are the remaining open items above. No `plugin.json` manifest yet — deliberately deferred until the
enterprise install mechanics are confirmed.
