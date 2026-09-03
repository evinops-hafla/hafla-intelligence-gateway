# Authoring & changing EvWA skills

How to add or edit a skill without shipping the drift bugs this repo has actually hit. The five
content conventions (cite integer keys, source-honesty, freshness, money labels, route-out) are in
[`README.md`](README.md) § "Conventions every skill follows" — this doc is the **verification
discipline** around them.

## The one rule that would have prevented most bugs

> **Verify against the LIVE gateway, not a commit message or your memory.** Tools iterate under the
> skills. In one week, `costAed` flipped from `{avg,min,max}` to a tier-preferred `{aed,tier,…}` anchor,
> and a `price_anchor` call written from a commit message used the wrong param (`id` vs `productId`).
> Both were invisible to a static read; both were caught by running against prod.

## Gates before you commit a skill change

1. **Tool-call params** — every `tool({ … })` param must exist on the tool's `inputSchema`.
   Run `node scripts/verify-skills.mjs` (static, credential-free, also runs in CI). It checks params
   against `scripts/tool-schemas.json` — **a snapshot; refresh it** (re-capture from the tool's
   `inputSchema`, bump `capturedAt`) whenever the gateway adds/renames a param.
2. **Embedded SQL/Cypher** — **execute each one on prod** before shipping (`safe_sql_sandbox` /
   `safe_cypher_sandbox`). Column names on `haflaCore.*` are stable; `intelligence.*` views and Neo4j
   rels drift. `verify-skills.mjs --list-queries` lists them; execution is manual (needs gateway).
3. **Tool OUTPUT shapes** — describe what the tool *currently returns live*, not what a doc/PR says.
   Call the tool, read the actual JSON. (This is the `costAed` lesson.)
4. **Routing graph** — every skill must route to ≥1 sibling AND be routed to by ≥1 (no orphans /
   dead-ends). `verify-skills.mjs` enforces this; add reciprocal routes when you add a skill.
5. **Frontmatter** — `name`: kebab-case, ≤64, no "anthropic"/"claude", must equal the folder name.
   `description`: ≤1024 (platform max); **≤200 is safest** for the claude.ai upload UI, but Claude Code
   needs the trigger phrases — keep it tight but complete. `verify-skills.mjs` flags violations.

## Adding a new skill

1. `skills/<name>/SKILL.md` — YAML frontmatter (`name` = folder, `description` naming the trigger
   phrases) then instructions. Follow an existing skill's shape.
2. Wire the **routing graph**: route out to the relevant siblings, and add an inbound route from at least
   one sibling (+ the README "Route out" convention line).
3. `plugin.json` auto-discovers `skills/` — no manifest edit needed. Update the README skill table + layout.
4. Run `node scripts/verify-skills.mjs` (must PASS) and live-run every embedded query.

## Packaging & distribution

- `scripts/pack-skills.sh` → one `dist/<skill>.zip` per skill (the claude.ai upload format). Run
  `verify-skills.mjs` first — don't zip a skill that fails.
- Claude Code: the plugin/marketplace (see README). Claude Desktop: per-user zip upload +
  the org connector — see [`DESKTOP-SETUP.md`](DESKTOP-SETUP.md) (pending OAuth Stage 2).

## CI

`.github/workflows/ci.yml` runs `verify-skills.mjs` on every PR (static gate). Live query execution and
tool-output verification remain a manual pre-merge step — do them when you touch a tool-backed branch.
