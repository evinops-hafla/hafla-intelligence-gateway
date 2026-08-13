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
| 3   | `product-brief`        | designed, not built                 |
| 4   | `past-orders`          | designed, not built                 |
| 5   | `venue-recommendation` | designed (evidence-only), not built |

Design specs live in the sibling repo:
`hafla-intelligence/mcp-gateway/specs/history-and-future/history/research/intelligence-gateway/skills-wave-1/`
(`00-shared-context.md` + one `proposal-<skill>.md` each).

## Layout

```
packages/plugin/
  README.md                          # this file
  skills/
    supplier-discovery/SKILL.md      # the skill definition (portable Agent Skill)
```

Each skill is a portable `SKILL.md` (YAML frontmatter `name` + `description`, then instructions). The
`description` is what the host uses to decide when to invoke the skill, so it names the trigger phrases.

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
- **Tool migration** — PR #314/#316/#317/#319/#320 are deploying (2026-08-13). `supplier-discovery` is
  now **tool-first** (calls the live `supplier_discovery` tool; raw SQL only for what the tool defers —
  partner-fact, order-#, the WhatsApp "invisible" branch, the graph cross-check). **Build the remaining
  skills tool-first too:** `pricing-lookup` → `price_truth` + `productPriceBands` (#319);
  `product-brief` → `product_lookup`/`catalog_search`/`price_truth`; `past-orders` → `customer_360`.

This is a **spike**: one skill, the scaffold it needs, and the corrected delivery model — enough to
validate the end-to-end product path (skill → connector → gateway) on Claude Desktop before building
the remaining four.
