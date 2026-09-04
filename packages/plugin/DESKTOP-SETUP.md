# EvWA Intelligence on Claude Desktop / claude.ai — setup guide

> **✅ LIVE (staging pilot) — verified end-to-end 2026-09-05.** The Desktop/claude.ai OAuth connector is
> built, **enabled, and verified working**: a real `@hafla.com` Google sign-in through claude.ai reached the
> gateway (`authMethod=oauth_user`). It runs on the WorkOS **staging** environment as a controlled pilot; a
> **production** WorkOS environment is the final step before the team-wide announcement — **hold broad
> rollout until GA is announced.** Claude **Code** also works (see [`README.md`](README.md) § Install). The
> steps below are the connect runbook; remaining pre-GA items are the production flip + a real-teammate
> end-to-end + exact UI labels.

## What this enables

Your team asks in plain English in **Claude Desktop Chat/Cowork**, and Claude answers using the six
EvWA skills over our own data (`mcp.hafla.com`): `supplier-discovery`, `pricing-lookup`,
`product-brief`, `past-orders`, `venue-recommendation`, `event-needs`.

> **New to the skills?** The persona × surface quickstart, the first-success query, and per-skill starter
> prompts are in [`SKILLS-GUIDE.md`](SKILLS-GUIDE.md) — hand teammates that page. This file is the
> connector/skill **install** runbook.

## How Desktop distribution actually works (from current Anthropic docs)

Two independent pieces — **you can push one, not the other**:

| Piece                                  | Who installs it                                   | Org-wide push?                                                        |
| -------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| **The gateway connector** (remote MCP) | Owner adds it org-wide; each member connects once | ✅ Owner-deployable                                                   |
| **The six skills**                     | **Each member uploads the zips themselves**       | ❌ **No org-wide skill push exists on ANY plan** (Team or Enterprise) |

So the rollout is: **owner deploys the connector once → each teammate connects it + uploads the skill
zips.** Distribute the zips via this repo + this guide.

## Prerequisites (built + enabled on staging; production env at GA)

- ✅ **Gateway is an OAuth resource server.** `mcp.hafla.com` serves RFC 9728 Protected Resource Metadata
  at `/.well-known/oauth-protected-resource/mcp`, returns `401` + `WWW-Authenticate`, and validates a
  resource-bound `aud=https://mcp.hafla.com/mcp`. Built + tested + **live on staging** — the operator
  flipped `OAUTH_PATH_ENABLED` (2026-09-05, verified); a production flip is the GA step.
- ✅ **Auth Server = WorkOS AuthKit** (decision made). It federates Google login for `@hafla.com` and mints
  the resource-bound tokens. **The MCP client self-registers** from the connector URL — **you do NOT paste
  a Client ID or Secret.** (WorkOS has both DCR and CIMD enabled — claude.ai/Desktop use DCR, Claude Code
  uses CIMD; neither needs a secret. Staging environment today; a production WorkOS environment is a
  follow-on before a team-wide GA.)
- Reachability: `mcp.hafla.com` (already public) is reachable from Anthropic's cloud egress.

## Part 1 — Owner: add the org connector (one-time)

1. **Organization settings → Connectors → Add**.
2. Hover **Custom → select "Web"**.
3. **Remote MCP server URL:** `https://mcp.hafla.com/mcp`.
4. **Add.** Because the client **self-registers** (DCR on this surface), adding by URL is all that's
   needed — there is **no** Client ID/Secret to paste. The connector then appears (labeled "Custom") for
   all members to connect.

> Only Owners can add connectors on Team/Enterprise. Verify the exact menu labels in your admin console —
> Anthropic's UI has been relabeled and docs trail it. **Open item:** if the org-wide connector flow still
> asks for credentials under Advanced settings, confirm at go-live whether DCR covers it (per-user
> add-by-URL definitely needs none).

## Part 2 — Each teammate (self-serve, ~3 min)

1. **Enable code execution** (Settings/Features) — skills won't appear without it.
2. **Customize → Connectors →** find **EvWA Intelligence** (Custom) **→ Connect** → sign in with your
   `@hafla.com` Google account (per-user OAuth; Claude only sees what you can).
3. **Customize → Skills → Add →** upload each skill **zip** (produced below). _(Confirm the exact menu
   label — "Customize → Skills" vs "Settings → Features" — in your workspace; docs disagree.)_

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

## Open items to confirm at go-live

- [x] **THE GATE:** operator flipped `OAUTH_PATH_ENABLED` on staging 2026-09-05 + verified a live connect.
- [x] Staging pilot LIVE. **Team-wide GA still waits for the production WorkOS env** (the remaining step).
- [ ] Exact Desktop menu labels (Connectors path; Skills-upload path).
- [ ] Org-connector Advanced-settings: DCR fully covers add-by-URL, or does the org flow still want
      credentials? (per-user add-by-URL needs none.)
- [ ] End-to-end on a real *teammate* (operator end-to-end done 2026-09-05): connect → skill → real gateway query.

> Identity note: a WorkOS access token carries no Google `hd` claim; access is restricted to `@hafla.com`
> at the Auth Server, and the gateway independently re-checks the token's email domain + active-employee
> status. No `hd`-propagation step is needed.

Full internal design: private
`mcp-gateway/specs/history-and-future/research/2026-08-web-connector-oauth/`.
