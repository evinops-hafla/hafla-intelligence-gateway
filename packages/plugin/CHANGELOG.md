# Changelog

All notable changes to the `evwa-intelligence` Claude Code plugin (`packages/plugin`) are documented here. The bridge has its own [CHANGELOG](../intelligence-mcp-bridge/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-07

This release **is** the `0.1.0 → 0.2.0` bump (`plugin.json` + `marketplace.json`). The plugin is git-distributed — merge is the release; there is no npm publish or version tag.

### Added

- Byte-identical `OUTPUT-CONVENTIONS` block embedded in all 6 `SKILL.md` files (table default, labelled money, bands not extremes, `Sources:` footer, artifact threshold), enforced by `scripts/verify-skills.mjs` in CI.
- Guides: `SKILLS-GUIDE.md` (persona × surface quickstart + live-verified starter prompts), `SETUP-PROMPT.md` (bridge/gcloud setup + verify), `CLAUDE-CODE-OAUTH.md` (Claude Code OAuth / CIMD runbook), `AUTHORING.md` (add/change a skill), `DESKTOP-SETUP.md` (Desktop connector + skill-zip runbook). Root `AGENTS.md` (+ `CLAUDE.md` symlink) — the agent operating contract.
- `eval/` answer-quality harness — Tier-1 routing over 69 golden cases + Tier-2 trajectory shape/grounding assertions with recorded fixtures (`--check` / `--score` run credential-free). The routing runner is provider-agnostic (Anthropic canonical, or Google AI Studio / Gemini as a cross-model proxy) via an extracted `eval/providers/` layer.
- `scripts/doctor.sh` — Claude Code preflight (node / gcloud / token / bridge `tools/list`) with an accurate 403 audience-mismatch diagnosis.
- `scripts/tool-schemas.json` — gateway tool-param snapshot (24 tools); source of truth for the harness param checks.
- `event-needs` (wave-1.5) skill; `pricing-lookup` total-delivered-cost route (`delivery_fee`); `past-orders` corporate branch (`get_org_events`) + `top_orgs` leaderboard; real freshness disclosures via `get_data_freshness`.

### Docs

- **OAuth onboarding.** The claude.ai / Claude Desktop **OAuth Web connector** (WorkOS AuthKit, DCR, add-by-URL, no client ID/secret) reached **production GA** 2026-09-05; the **Claude Code OAuth (CIMD)** path is documented + verified live on two machines, 2026-09-07/08 (`CLAUDE-CODE-OAUTH.md`) — and is now the **default** Claude Code connection — the bridge / `gcloud` path (`SETUP-PROMPT.md`) is the fallback for automation, M2M, and non-OAuth clients (OAuth is immune to the branded-client 403 the bridge can hit when an IDE hijacks the gcloud login to a branded OAuth client — a per-machine state, not from mere IDE installation). A client→connection-profile map (every client → the invariant name `hafla-evwa-idl-gateway`) lands in the root + plugin READMEs and `SKILLS-GUIDE.md`.
- **Post-review hardening.** Reconciled CIMD-vs-DCR conflation, a staging-vs-prod GA wording contradiction, and an OAuth-unaware troubleshooting fallback; the three drift-survey tool caveats (`price_truth.lastOrderedAt`, `related_products.rankBy`/`liftReliable`, `get_org_events.additionalDomains` merge/dedup) were **live-verified against the gateway 2026-09-07**, and `additionalDomains` now ships as a real `get_org_events({ … })` call literal so `verify-skills.mjs` covers the param.

### Changed

- **Plugin is now skills-only — it no longer auto-wires a gateway connector.** 0.1.0 wired the `gcloud` bridge (`npx @hafla/intelligence-mcp-bridge`) into every install; that forced the bridge on everyone and 403s wherever an IDE hijacks the gcloud login. Installing now adds just the six skills; connect the gateway **separately** — OAuth (default) via `CLAUDE-CODE-OAUTH.md`, or the bridge via `SETUP-PROMPT.md`. Existing users who relied on the auto-wired bridge must add a connection after upgrading.

### Fixed

- Live-verified tool-contract bugs: `price_anchor` takes `productId` (not `id`); `supplier_discovery.costAed` is a tier-preferred anchor object (not `{avg,min,max}`); skill tooling made CRLF-safe for Windows checkouts.
- `product-brief` no longer routes support/ticket **escalations** to itself — those are out of scope until a dedicated escalations skill / per-product escalations data exists (Greptile PR #15 review).

## [0.1.0] — 2026-08-23

### Added

- Claude Code plugin + repo-root marketplace manifests (`evwa-intelligence`), wiring the gateway connector via `npx @hafla/intelligence-mcp-bridge@1.0.7`.
- Wave-1 skills, tool-first and live-tested against the deployed gateway: `supplier-discovery`, `pricing-lookup`, `product-brief`, `past-orders`, `venue-recommendation` ([#12](https://github.com/evinops-hafla/hafla-intelligence-gateway/pull/12)).
