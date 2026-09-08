# EvWA Intelligence on Claude Desktop / claude.ai — setup guide

> **✅ LIVE — production GA, operator-verified 2026-09-05; teammate end-to-end confirmed 2026-09-08 (Chat / Cowork / Code).** The Desktop/claude.ai OAuth connector is
> built, **enabled, and verified working in production**: a real `@hafla.com` Google sign-in through claude.ai
> reached the gateway (`authMethod=oauth_user`) on the **production** WorkOS environment (prod issuer
> `secure-grace-01.authkit.app`). Claude **Code** also works (see [`README.md`](README.md) § Install). The
> steps below are the connect runbook; a teammate confirmed the connector
> end-to-end in Chat, Cowork, and Code (2026-09-08). Remaining polish: confirm the
> exact Desktop UI labels.

## What this enables

Your team asks in plain English in **Claude Desktop Chat/Cowork**, and Claude answers using the six
EvWA skills over our own data (`mcp.hafla.com`): `supplier-discovery`, `pricing-lookup`,
`product-brief`, `past-orders`, `venue-recommendation`, `event-needs`.

> **New to the skills?** The persona × surface quickstart, the first-success query, and per-skill starter
> prompts are in [`SKILLS-GUIDE.md`](SKILLS-GUIDE.md) — hand teammates that page. This file is the
> connector/skill **install** runbook.

> **What's a "connector"?** It's Claude's word for a **remote MCP server you attach to Claude** so it can
> use that server's tools. On Claude Desktop / claude.ai you add one under **Settings → Connectors** by
> URL and sign in once — here, the EvWA gateway at `mcp.hafla.com`. It's the same gateway the Claude Code
> and bridge paths reach; "connector" is just the Desktop / claude.ai term for it.

> **Why the connector — not the `claude_desktop_config.json` bridge — on Desktop.** A **local stdio** MCP
> server (the bridge, configured in `claude_desktop_config.json`) works in Desktop **Chat** but is **not
> available in Cowork or Code sessions** — a known Claude Desktop limitation (anthropics/claude-code
> [#42453](https://github.com/anthropics/claude-code/issues/42453),
> [#35511](https://github.com/anthropics/claude-code/issues/35511)). It surfaces as a recurring **"MCP
> hafla-evwa-idl-gateway: Couldn't start for Cowork and Code sessions"** popup on every launch (fires
> independent of gcloud/auth — even when the bridge is otherwise healthy). **Remote connectors work
> everywhere — Chat, Cowork, and Code** — so the OAuth connector below is the only way to reach the gateway
> in Cowork/Code, and moving to it (and removing the bridge from `claude_desktop_config.json`) stops the
> popup. When you remove it, delete **only** the `hafla-evwa-idl-gateway` key from inside `mcpServers` and
> **keep every other server you have** — do **not** replace `mcpServers` with `{}` (that wipes all your MCP
> servers; back the file up first). Custom connectors live in the app's own state, not the config file, so
> `mcpServers` being empty afterward is normal **only if EvWA was your sole entry**.

## How Desktop distribution actually works (from current Anthropic docs)

Two independent pieces — **you can push one, not the other**:

| Piece                                  | Who installs it                                   | Org-wide push?                                                        |
| -------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| **The gateway connector** (remote MCP) | Owner adds it org-wide; each member connects once | ✅ Owner-deployable                                                   |
| **The six skills**                     | **Each member uploads the zips themselves**       | ❌ **No org-wide skill push exists on ANY plan** (Team or Enterprise) |

So the rollout is: **owner deploys the connector once → each teammate connects it + uploads the skill
zips.** Distribute the zips via this repo + this guide.

## Prerequisites (production GA — live 2026-09-05)

- ✅ **Gateway is an OAuth resource server.** `mcp.hafla.com` serves RFC 9728 Protected Resource Metadata
  at `/.well-known/oauth-protected-resource/mcp`, returns `401` + `WWW-Authenticate`, and validates a
  resource-bound `aud=https://mcp.hafla.com/mcp`. Built + tested + **live in production** — the operator
  flipped `OAUTH_PATH_ENABLED` on the prod WorkOS env (2026-09-05, verified); prod issuer
  `secure-grace-01.authkit.app`.
- ✅ **Auth Server = WorkOS AuthKit** (decision made). It federates Google login for `@hafla.com` and mints
  the resource-bound tokens. **The MCP client self-registers** from the connector URL — **you do NOT paste
  a Client ID or Secret.** (WorkOS has both DCR and CIMD enabled — claude.ai/Desktop use DCR, Claude Code
  uses CIMD; neither needs a secret. The production WorkOS environment is live — prod issuer
  `secure-grace-01.authkit.app`.) **For the Claude Code (CIMD) runbook** see
  [`CLAUDE-CODE-OAUTH.md`](CLAUDE-CODE-OAUTH.md) (verified 2026-09-07); this doc is the
  claude.ai + Claude Desktop (DCR) connector path.
- Reachability: `mcp.hafla.com` (already public) is reachable from Anthropic's cloud egress.

## Part 1 — Owner: add the org connector (one-time)

1. **Organization settings → Connectors → Add**.
2. Hover **Custom → select "Web"**.
3. **Name:** `EvWA Intelligence` · **Remote MCP server URL:** `https://mcp.hafla.com/mcp`. (The name is the label teammates look for in Part 2.)
4. **Add.** Because the client **self-registers** (DCR on this surface), adding by URL is all that's
   needed — there is **no** Client ID/Secret to paste. The connector then appears (labeled "Custom") for
   all members to connect.

> On Team/Enterprise, custom connectors are usually **owner-added org-wide** (Part 1); members then just **Connect** (Part 2). Only if your workspace permits members to add their own connectors can a teammate add the URL directly. Verify the exact menu labels in your admin console —
> Anthropic's UI has been relabeled and docs trail it. **Open item:** if the org-wide connector flow still
> asks for credentials under Advanced settings, confirm whether DCR covers it (per-user
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

Read-only; answers cite real integer keys (never UUIDs); supplier **cost** vs client **sell** price is
always labeled; semantic conversation search is WhatsApp-only. The full set is the single source of truth
in [`SKILLS-GUIDE.md`](SKILLS-GUIDE.md) § "Good to know (the honesty rules)". One Desktop-specific note:

- Skills instruct Claude to call the connector's tools by name — they do **not** reach the gateway from a
  sandbox script (the correct claude.ai pattern).

## Troubleshooting (OAuth connector)

- **Sign-in fails or the browser hangs** — cancel and click **Connect** again; make sure you pick your
  `@hafla.com` Google account (a personal account is rejected at the Auth Server).
- **Connected but tools error / repeated 401** — disconnect the connector (Settings → Connectors → the
  EvWA connector → Disconnect) and Connect again to re-run OAuth.
- **`employee_inactive` / access denied after a clean sign-in** — you reached the gateway but it gates
  your identity; ask Ops to set `isEmployeeActive=true` for your `@hafla.com` account. That is an
  authorization issue, not a setup one.
- **Cowork/Code can't see the tools but Chat can** — you're likely on the local stdio bridge, not the
  connector; the bridge doesn't run in Cowork/Code (see the top of this doc). Use the connector.

## Open items (post-GA polish)

- [x] **THE GATE:** `OAUTH_PATH_ENABLED` flipped — staging pilot first, then the prod cutover below (both 2026-09-05), each with a verified live connect.
- [x] **Production GA LIVE 2026-09-05** — prod WorkOS env cut over (issuer `secure-grace-01.authkit.app`), real `@hafla.com` connect verified (`authMethod=oauth_user`).
- [ ] Exact Desktop menu labels (Connectors path; Skills-upload path).
- [ ] Org-connector Advanced-settings: DCR fully covers add-by-URL, or does the org flow still want
      credentials? (per-user add-by-URL needs none.)
- [x] End-to-end on a real _teammate_ — Hardik, 2026-09-08: the org connector auto-appeared, connected on sign-in, and returned real cited answers in Chat, Cowork, and Code (no popup; empty local `mcpServers`).

> Identity note: a WorkOS access token carries no Google `hd` claim; access is restricted to `@hafla.com`
> at the Auth Server, and the gateway independently re-checks the token's email domain + active-employee
> status. No `hd`-propagation step is needed.

Full internal design: private
`mcp-gateway/specs/history-and-future/research/2026-08-web-connector-oauth/`.
