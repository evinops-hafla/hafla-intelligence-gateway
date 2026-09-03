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
   `description`: ≤1024 (platform max); the claude.ai UI shows only ~200 chars, so **front-load the
   disambiguating trigger (and any NOT-clause) into the first 200** rather than shortening — `verify-skills.mjs`
   errors if a skill's first 200 chars lack its core trigger phrase (per-skill `TRIGGER_PHRASES`).
6. **Output-conventions block** — the `OUTPUT-CONVENTIONS` block (table/money-÷100/bands/dates/Sources
   footer/artifact) must be present and **byte-identical** in every SKILL.md — a Desktop zip ships only
   its own SKILL.md, so the block has to live inside each. `verify-skills.mjs` errors on drift; when you
   edit the block, edit it in all 6 (copy one into the others) and re-run until PASS.

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
- **Preflight (Claude Code path):** `bash scripts/doctor.sh` — checks Node≥24 (+ the version-manager/GUI
  path trap), the active gcloud account is `@hafla.com`, the identity token mints, and a real `tools/list`
  round-trips through the bridge. `--skip-live` skips the last (network) check. macOS/Linux only.

## Answer-quality eval (routing)

`verify-skills.mjs` can't tell whether a question routes to the *right* skill — that lives entirely in
the frontmatter descriptions, and a description bug (or the semantically-wrong/schema-valid class like
`event_playbook family="Wedding"`) passes every static gate and only fails at answer time. The
[`eval/`](eval/) directory holds the routing eval — see [`eval/README.md`](eval/README.md). **After any
description edit**, run the credential-free structural check:

```bash
node eval/run-routing-eval.mjs --check      # golden-set structure (CI-safe, no key)
node eval/run-routing-eval.mjs              # the real routing eval (needs ANTHROPIC_API_KEY)
```

## CI

`.github/workflows/ci.yml` runs `verify-skills.mjs` on every PR (static gate). The routing eval and live
query/tool-output verification stay **out of CI** (they need a credential/token) — they are the manual
pre-merge step; do them when you touch a description or a tool-backed branch.
