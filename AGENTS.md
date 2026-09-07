# AGENTS.md — hafla-intelligence-gateway

Operating contract for AI coding agents (Claude Code and others) working in this
repo. Human orientation lives in [`README.md`](README.md); Claude Code also reads
this file (and `CLAUDE.md`, a symlink to it) automatically.

## What this repo is

The **public client side** of Hafla's intelligence stack: small, audit-friendly
packages that let Claude Code, Claude Desktop, Cursor, Gemini CLI, and Antigravity
reach the **MCP Gateway** at `mcp.hafla.com`. The gateway _server_ (data lakes,
identity resolution, AlloyDB / Neo4j / Vertex) lives in a **private** monorepo —
not here.

Two "gateways", one convention — do not conflate them:

- **MCP Gateway (server)** — the Cloud Run service at `https://mcp.hafla.com`
  (private repo).
- **Intelligence Gateway (client)** — this repo: the bridge, the plugin, the
  skills.

## The three layers (the distinction that trips people up)

1. **Bridge** — `packages/intelligence-mcp-bridge/` (npm `@hafla/intelligence-mcp-bridge`).
   A stdio↔HTTPS shim: mints a Google ID token from the user's own `gcloud` and
   forwards JSON-RPC to the gateway. Zero runtime dependencies.
2. **Plugin** — `packages/plugin/` (`evwa-intelligence`). The Claude Code plugin:
   it bundles the six skills and wires **no** gateway transport — connecting is a
   separate step (OAuth is the default; the bridge is the fallback). Git-distributed
   — this repo is its own marketplace (`.claude-plugin/marketplace.json`).
3. **Skills** — `packages/plugin/skills/<name>/SKILL.md`. Portable Agent Skills
   (YAML frontmatter `name` + `description`, then instructions). The description
   decides when a skill triggers; the body tells the agent how to answer using the
   gateway's read-only tools.

## The gateway surface

- **24 read-only tools.** The param-contract snapshot is
  [`packages/plugin/scripts/tool-schemas.json`](packages/plugin/scripts/tool-schemas.json) —
  the source of truth for the credential-free CI param check.
- **Read-only, always.** No writes. Margin / markup / pricing-strategy is **out of
  scope** (wave-2). Cite human-readable integer keys (`orderNumber` /
  `userEventNumber` / ticket #), **never UUIDs**.
- **Auth paths:** (1) static shared-secret bearer; (2) the gcloud bridge — mints a
  Google ID token, subject to a 403 audience-mismatch gotcha (fix: vanilla
  `gcloud auth login`; but a resident IDE — Cloud Code / Antigravity / Gemini
  Code Assist — can hijack the login and re-mint a branded client that still
  403s, so OAuth is preferred — see the bridge README troubleshooting);
  (3) OAuth via WorkOS AuthKit — claude.ai / Desktop use **DCR**, Claude Code
  uses **CIMD** (resource-bound `aud`, so it cannot 403).
- **End users use the bare connector name `hafla-evwa-idl-gateway`.** Suffixes
  (`-oauth` / `-token` / `-local` / `-bridge`) are dev-bench only.

## Invariants — an agent MUST hold these

- **After ANY skill edit, run** `node packages/plugin/scripts/verify-skills.mjs`.
  It is the credential-free gate: tool-call param drift vs the snapshot,
  frontmatter limits, routing-graph orphans, and the byte-identical
  OUTPUT-CONVENTIONS block. It must PASS (warnings are allowed).
- **Refresh `tool-schemas.json`** whenever the gateway adds or renames a tool or a
  param — re-capture from the live tool `inputSchema` and bump `capturedAt`.
- **Live-verify before shipping.** Every embedded SQL / Cypher query and every
  claim about a tool's _output_ shape must be verified against the live gateway
  (see `AUTHORING.md` Gate #3 — "call the tool, read the actual JSON") and tagged
  with the evidence. Never assert an output shape from memory or a PR description.
- **The OUTPUT-CONVENTIONS block is byte-identical across all six skills** — change
  all six or none; `verify-skills.mjs` enforces it.
- **NEVER create a git tag of the form `vX.Y.Z`.** That tag triggers
  `release.yml`, which publishes the **bridge** to npm. The plugin ships by git
  merge only — no version tag. Only a deliberate bridge release is tagged (the
  root README documents the review-first release flow).
- **Commits:** use a Conventional-Commits prefix (`type(scope): summary`) and a
  structured body — Why / What changed / Verification, plus Battle scars /
  Caution / Depends on when relevant — and **never** add a `Co-Authored-By`
  trailer. This is a repo convention held by author/agent discipline: no
  commit-msg hook or CI check enforces it here, so keep to it deliberately.
- **CI** (`.github/workflows/ci.yml`) runs the tests, `verify-skills`, the
  credential-free eval gates, and the bridge symlink smoke on ubuntu / macOS /
  windows (Node 24.15.0). Keep them green. Skill tooling is CRLF-safe
  (`.gitattributes` + parser normalization) for the Windows runner — don't
  regress it.
- **Docs lint:** markdownlint here has `MD013` off, and most docs use long-line
  prose. The two paste-prompts (`SETUP-PROMPT.md`, `CLAUDE-CODE-OAUTH.md`) are held
  to markdownlint-default (0 issues) + prettier-clean — keep them that way.

## Where things live

| Path                                        | What                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/intelligence-mcp-bridge/`         | The npm bridge + its README + `PREREQUISITES.md`                       |
| `packages/plugin/skills/<name>/SKILL.md`    | The six Agent Skills                                                   |
| `packages/plugin/scripts/verify-skills.mjs` | The static integrity gate (run after skill edits)                      |
| `packages/plugin/scripts/tool-schemas.json` | The 24-tool param snapshot (source of truth)                           |
| `packages/plugin/scripts/doctor.sh`         | Claude Code bridge preflight + 403 diagnosis                           |
| `packages/plugin/eval/`                     | Answer-quality evals (Tier-1 routing, Tier-2 trajectory)               |
| `packages/plugin/*.md`                      | Guides (see below)                                                     |
| `.claude-plugin/marketplace.json`           | This repo as its own plugin marketplace                                |
| `.github/workflows/`                        | `ci.yml` (gates) and `release.yml` (bridge npm publish, tag-triggered) |

## Onboarding / connect docs — route users here, don't re-explain

- Which skill answers what → `packages/plugin/SKILLS-GUIDE.md`
- Connect Claude Code — **default: OAuth (CIMD)** → `packages/plugin/CLAUDE-CODE-OAUTH.md` (no `gcloud`; immune to the branded-client callback-hijack 403 that breaks the bridge on machines with Cloud Code / Antigravity / Gemini Code Assist installed)
- Connect Claude Code via the bridge / `gcloud` — fallback for automation, M2M, and non-OAuth clients → `packages/plugin/SETUP-PROMPT.md`
- Connect Claude Desktop / claude.ai (DCR connector) → `packages/plugin/DESKTOP-SETUP.md`
- Add or change a skill → `packages/plugin/AUTHORING.md`
- Bridge install / prerequisites → `packages/intelligence-mcp-bridge/README.md`

## The eval harness

`packages/plugin/eval/` holds Tier-1 routing (`golden-routing.json` +
`run-routing-eval.mjs`) and Tier-2 trajectory (`assertions.mjs` +
`golden-trajectory.json` + `run-trajectory-eval.mjs`). The `--check` /
`--self-test` / `--score` modes are credential-free and CI-gated; the model-backed
routing run and live trajectory recording need `ANTHROPIC_API_KEY` / gateway access
and stay manual.
