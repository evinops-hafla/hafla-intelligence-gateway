# Changelog

All notable changes to the `evwa-intelligence` Claude Code plugin (`packages/plugin`) are documented here. The bridge has its own [CHANGELOG](../intelligence-mcp-bridge/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Docs only — the claude.ai / Claude Desktop **OAuth Web connector** (WorkOS AuthKit over Google `@hafla.com`, add-by-URL, no client ID/secret) reached **production GA** 2026-09-05. `README.md`, `DESKTOP-SETUP.md` and the root README updated; no plugin behaviour change, no version bump.

## [0.2.0] — 2026-09-05

### Added

- Byte-identical `OUTPUT-CONVENTIONS` block embedded in all 6 `SKILL.md` files (table default, labelled money, bands not extremes, `Sources:` footer, artifact threshold), enforced by `scripts/verify-skills.mjs` in CI.
- Guides: `SKILLS-GUIDE.md` (persona × surface quickstart + live-verified starter prompts), `SETUP-PROMPT.md` (paste-into-Claude-Code setup + verify), `AUTHORING.md` (add/change a skill), `DESKTOP-SETUP.md` (Desktop connector + skill-zip runbook).
- `eval/` answer-quality harness — Tier-1 routing over 67 golden cases + Tier-2 trajectory shape/grounding assertions with recorded fixtures (`--check` / `--score` run credential-free).
- `scripts/doctor.sh` — Claude Code preflight (node / gcloud / token / bridge `tools/list`) with an accurate 403 audience-mismatch diagnosis.
- `scripts/tool-schemas.json` — gateway tool-param snapshot (24 tools, captured 2026-09-05); source of truth for the harness param checks.
- `event-needs` (wave-1.5) skill; `pricing-lookup` total-delivered-cost route (`delivery_fee`); `past-orders` corporate branch (`get_org_events`); real freshness disclosures via `get_data_freshness`.

### Fixed

- Live-verified tool-contract bugs: `price_anchor` takes `productId` (not `id`); `supplier_discovery.costAed` is a tier-preferred anchor object (not `{avg,min,max}`); skill tooling made CRLF-safe for Windows checkouts.

## [0.1.0] — 2026-08-23

### Added

- Claude Code plugin + repo-root marketplace manifests (`evwa-intelligence`), wiring the gateway connector via `npx @hafla/intelligence-mcp-bridge@1.0.7`.
- Wave-1 skills, tool-first and live-tested against the deployed gateway: `supplier-discovery`, `pricing-lookup`, `product-brief`, `past-orders`, `venue-recommendation` ([#12](https://github.com/evinops-hafla/hafla-intelligence-gateway/pull/12)).
