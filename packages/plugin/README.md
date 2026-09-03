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
- **Freshness** — when disclosing that window, cite the real watermark from `get_data_freshness`
  (`waCorpusGeneration.lastSyncAt` = the WhatsApp corpus; `haflaCoreMirror.lastSyncAt` = the ~4h
  order/history mirror) instead of a hardcoded date.
- **Read-only** — no create/book/register (the gateway exposes no write tools).
- **Money labels** — partner `costAed` (supplier→Hafla) is never a client price; selling price is never
  a cost. Label which one a number is.
- **Route out** — supply → `supplier-discovery`, price → `pricing-lookup`, 101 → `product-brief`,
  history → `past-orders`, venue evidence → `venue-recommendation`; pricing _strategy_ and _margin_ are
  out of scope (wave-2 commercial intelligence).

## Install

**Claude Code (works today):**

```bash
/plugin marketplace add evinops-hafla/hafla-intelligence-gateway
/plugin install evwa-intelligence@hafla-intelligence-gateway
```

Installing wires the 5 skills **and** the gateway connector (`hafla-evwa-idl-gateway`, via
`npx @hafla/intelligence-mcp-bridge`) together. Prerequisite: `gcloud` installed + `gcloud auth login`
with your `@hafla.com` account — the bridge mints a Google ID token and cannot bundle auth (see the
bridge README for full onboarding).

**Claude Desktop / claude.ai (Chat / Cowork):** per-user — upload each skill folder as a **zip**
(Customize → Skills → Add; code-execution enabled) and connect the gateway. **Not live yet:** the
claude.ai remote-connector surface needs the gateway to speak OAuth 2.1 (OAuth "Stage 2", not built),
so Claude Code is the working surface today.

## Prerequisites (to run a skill)

1. The EvWA Intelligence gateway available as MCP tools — wired automatically by the Claude Code plugin
   above, or added as a **connector** on Claude Desktop — so `safe_sql_sandbox`, `safe_cypher_sandbox`,
   `search_internal_knowledge`, `analyze_identity_graph`, `get_ticket_360`, plus the R1–R5 tools are
   available.
2. The skill installed on the surface (Claude Code plugin, or Claude Desktop skill zip).

## Distribution (researched 2026-08-23 vs current Anthropic docs)

- **Claude Code** — installable now via the plugin/marketplace above; connector auth = bridge + Google
  token (stdio).
- **claude.ai Chat / Cowork** — the remote connector calls from Anthropic's cloud and needs the gateway
  as an OAuth 2.1 resource server → **OAuth Stage 2 (deferred).** Blocked until then.
- **No org-wide custom-Skill distribution exists on any plan** (incl. Enterprise) — skills are per-user
  zip upload; only the remote **connector** is org-deployable by an owner.
- Tool migration **DONE** (PR #314/#316/#317/#319/#320, 2026-08-14): all 5 skills are tool-first where a
  tool exists; remaining raw-SQL grains (generic `--Name--` price, per-host order enumeration, venue
  evidence) have no tool yet — noted in each SKILL.md's forward note.

## Status

Wave-1 is **built** (all 5 skills), **reviewed + live-tested** against the deployed gateway (20+
read-only tools; the tool surface grows — skills are tool-first where a tool exists, incl.
`price_anchor` (cost) + `supplier_brief` (partner dossier), and fall back to raw SQL otherwise), and
**packaged** as a Claude Code plugin
(`.claude-plugin/plugin.json` + repo-root `marketplace.json`). A fresh-context adversarial review +
running every embedded SQL/Cypher on prod caught and fixed a series of tool-contract and data-reality
issues (named-param shapes, `describe_table` needing `schema`, `catalog_search` excluding generics,
`supplier_discovery.costAed` being an object, `delivered[]` including stated-only rows, a join fan-out,
~4%-`exactAddress` / ~17.6%-site-type coverage). Every tool call and SQL query is verified against the
live contracts/schema.

**Remaining:** a hands-on `/plugin install` + one-query run on a gcloud-authed machine, then merge
([#12](https://github.com/evinops-hafla/hafla-intelligence-gateway/pull/12)); the claude.ai/Desktop
surface awaits OAuth Stage 2. **Maturity:** the underlying R1/pricing/supplier tools are recent
first-cuts (some flagged pre-alpha) — richer IDL-processed versions are planned, so treat tool outputs
as improving, not final.
