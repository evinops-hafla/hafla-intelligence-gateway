# EvWA Intelligence on Claude Desktop / claude.ai — setup guide

> **⚠ DRAFT — pending OAuth Stage 2.** The Desktop/claude.ai path is **not live yet**: the remote
> connector is called from Anthropic's cloud and needs the gateway to speak **OAuth 2.1** (Stage 2,
> unbuilt). This is the launch runbook — steps are grounded in current Anthropic docs, but the bits
> marked **TBD** depend on the chosen Auth Server (WorkOS vs Clerk) and must be confirmed hands-on at
> go-live. **Works today instead:** Claude **Code** (see [`README.md`](README.md) § Install).

## What this enables

Your team asks in plain English in **Claude Desktop Chat/Cowork**, and Claude answers using the six
EvWA skills over our own data (`mcp.hafla.com`): `supplier-discovery`, `pricing-lookup`,
`product-brief`, `past-orders`, `venue-recommendation`, `event-needs`.

> **New to the skills?** The persona × surface quickstart, the first-success query, and per-skill starter
> prompts are in [`SKILLS-GUIDE.md`](SKILLS-GUIDE.md) — hand teammates that page. This file is the
> connector/skill **install** runbook.

## How Desktop distribution actually works (from current Anthropic docs)

Two independent pieces — **you can push one, not the other**:

| Piece | Who installs it | Org-wide push? |
| ----- | --------------- | -------------- |
| **The gateway connector** (remote MCP) | Owner adds it org-wide; each member connects once | ✅ Owner-deployable |
| **The six skills** | **Each member uploads the zips themselves** | ❌ **No org-wide skill push exists on ANY plan** (Team or Enterprise) |

So the rollout is: **owner deploys the connector once → each teammate connects it + uploads the skill
zips.** Distribute the zips via this repo + this guide.

## Prerequisites (must be true before the steps below work)

- **[TBD — Stage 2]** The gateway (`mcp.hafla.com`) is an OAuth 2.1 **resource server** (serves RFC 9728
  Protected Resource Metadata, returns `401`+`WWW-Authenticate`, validates a resource-bound `aud`).
- **[TBD — vendor]** A hosted **Auth Server** is configured (WorkOS AuthKit is the current pick; Clerk is
  the #2, conditional on external-`aud` support) — it federates Google login for `@hafla.com` and mints
  tokens with `aud=https://mcp.hafla.com/mcp`. You will have an **OAuth Client ID + Client Secret** from it.
- Reachability: `mcp.hafla.com` (already public) must be reachable from Anthropic's cloud egress — it is.

## Part 1 — Owner: add the org connector (one-time)

1. **Organization settings → Connectors → Add**.
2. Hover **Custom → select "Web"**.
3. **Remote MCP server URL:** `https://mcp.hafla.com/mcp`.
4. **Advanced settings →** paste the **OAuth Client ID** and **Client Secret** from the Auth Server **[TBD — vendor]**.
5. **Add.** The connector now appears (labeled "Custom") for all members to connect.

> Only Owners can add connectors on Team/Enterprise. Verify the exact menu labels in your admin console —
> Anthropic's UI has been relabeled and docs trail it.

## Part 2 — Each teammate (self-serve, ~3 min)

1. **Enable code execution** (Settings/Features) — skills won't appear without it.
2. **Customize → Connectors →** find **EvWA Intelligence** (Custom) **→ Connect** → sign in with your
   `@hafla.com` Google account (per-user OAuth; Claude only sees what you can).
3. **Customize → Skills → Add →** upload each skill **zip** (produced below). *(Confirm the exact menu
   label — "Customize → Skills" vs "Settings → Features" — in your workspace; docs disagree.)*

## Packaging the skill zips

From the repo root:

```bash
bash packages/plugin/scripts/pack-skills.sh     # → packages/plugin/dist/<skill>.zip  (6 zips)
```

Each zip contains `<skill>/SKILL.md`. Share the six zips (Slack/drive) with a link to this guide.
Re-run and re-share after any skill update — **skills do not auto-sync across surfaces**; each member
re-uploads. (Maintain the `SKILL.md` folders in Git as the source of truth.)

## What you get / honesty rules (same as Claude Code)

- **Read-only.** No create/book/register.
- Answers **cite real integer keys** (`orderNumber` / event # / ticket #), never UUIDs.
- **Semantic conversation search is WhatsApp-only** — Zendesk/Slack are keyword/structured, never
  claimed as semantic.
- Money labels: supplier **cost** ≠ client **sell** price; each number is labeled.
- Skills instruct Claude to call the connector's tools by name — they do **not** reach the gateway from a
  sandbox script (the correct claude.ai pattern).

## Open TBDs to confirm at go-live

- [ ] Stage 2 gateway RS live + Auth Server (WorkOS/Clerk) minting `aud=https://mcp.hafla.com/mcp`.
- [ ] Exact Desktop menu labels (Connectors path; Skills-upload path).
- [ ] Whether Google `hd` claim reaches the token, or we rely on the AS domain-allowlist for `@hafla.com`.
- [ ] End-to-end: connect connector → invoke a skill → real gateway query, on a real teammate's Desktop.

Full internal design (incl. the Auth Server vendor decision support): private
`mcp-gateway/specs/history-and-future/research/2026-08-web-connector-oauth/`.
