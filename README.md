# Hafla Intelligence Gateway

Public client packages for the Hafla MCP Gateway at `mcp.hafla.com`.

This repo is the public side of the Hafla intelligence stack: small, audit-friendly packages that let Claude Code, Claude Desktop, Cursor, Gemini CLI, Antigravity CLI, and Antigravity 2.0 reach the gateway. The gateway server itself (data lakes, identity resolution, etc.) lives in a private monorepo.

---

## Two "gateways" — one convention to keep them straight

| Term                              | What                                                                                                           | Where                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **MCP Gateway** (server)          | Cloud Run service at `https://mcp.hafla.com` — IAM-gated HTTP MCP endpoint, AlloyDB + Neo4j + Vertex AI Search | private — separate repo |
| **Intelligence Gateway** (client) | The bridge (npm), the Claude Code plugin, and the 6 skills it bundles — everything an employee installs to reach the MCP Gateway server | this repo               |

Talk about "the MCP Gateway server" when you mean the Cloud Run service; "the Intelligence Gateway" when you mean this repo or the user-facing pieces in it.

---

## Packages

| Package                                                                  | Type                                      | Status                  |
| ------------------------------------------------------------------------ | ----------------------------------------- | ----------------------- |
| [`packages/intelligence-mcp-bridge/`](packages/intelligence-mcp-bridge/) | npm — `@hafla/intelligence-mcp-bridge`    | 1.0.7 — live on npm     |
| [`packages/plugin/`](packages/plugin/)                                   | Claude Code plugin (git — this repo's marketplace) — bundles the 6 skills + wires the gateway connector by running the bridge via npx | 6 skills (5 wave-1 + `event-needs`), tool-first; verified in CI |

### `@hafla/intelligence-mcp-bridge`

stdio↔HTTPS shim that mints Google ID tokens via the user's own `gcloud` and forwards JSON-RPC to `mcp.hafla.com`. Zero runtime dependencies.

**Install + configure:** [packages/intelligence-mcp-bridge/README.md](packages/intelligence-mcp-bridge/README.md) §§ "Prerequisites" and "3. Add this MCP server block to your client config". The package README is the canonical install reference — it covers the launchd-subprocess constraint (macOS GUI apps don't see your shell's `nvm`-managed binaries, so the MCP config requires two explicit absolute paths) and the per-version-manager path table (`nvm` / `fnm` / Volta / `nvm-windows`).

### Two ways an employee connects

- **Bridge (today, every client):** Claude Code, Cursor, Gemini CLI, Antigravity, and Claude Desktop's developer MCP config use the bridge above — your own `gcloud` Google identity, stdio↔HTTPS.
- **OAuth Web connector (built, not yet enabled):** on claude.ai / Claude Desktop / Claude Code you can add `https://mcp.hafla.com/mcp` as a connector and sign in with Google — no `gcloud`, auto-refresh. It is **built + tested but dark** until an operator flips the gateway's `OAUTH_PATH_ENABLED` at go-live. The bridge is **not** being retired — it stays canonical for non-OAuth clients + automation. Setup: [`packages/plugin/DESKTOP-SETUP.md`](packages/plugin/DESKTOP-SETUP.md).

---

## Prerequisites

This bridge requires **Node 24 LTS** (currently `24.15.0` or any newer patch in the 24.x line).

We strongly recommend installing Node via a version manager rather than the OS installer.

- **macOS / Linux:** [`nvm`](https://github.com/nvm-sh/nvm) (recommended) or [`fnm`](https://github.com/Schniz/fnm)
- **Windows:** [`fnm`](https://github.com/Schniz/fnm) (recommended) or [`nvm-windows`](https://github.com/coreybutler/nvm-windows)

Once your manager is installed, the `.nvmrc` in this repo pins the right version automatically:

```bash
nvm install  # or: fnm install
nvm use      # or: fnm use
node -v      # should print v24.15.x
```

---

## Repo layout

```text
intelligence-gateway/
├── .claude-plugin/
│   └── marketplace.json            # this repo is its own Claude Code marketplace
├── packages/
│   ├── intelligence-mcp-bridge/    # @hafla/intelligence-mcp-bridge on npm
│   │   ├── src/index.js            # stdio↔HTTPS forwarder + token mint/cache
│   │   ├── src/version-check.js    # Node 24 LTS runtime guard
│   │   ├── tests/index.test.js     # node:test unit tests
│   │   ├── package.json
│   │   ├── README.md               # operator-facing install guide
│   │   ├── CHANGELOG.md
│   │   └── LICENSE                 # MIT (root LICENSE; the package symlinks via npm `files`)
│   └── plugin/                     # Claude Code plugin — bundles 6 skills + wires the bridge as MCP server
│       ├── .claude-plugin/plugin.json   # plugin manifest (name: evwa-intelligence)
│       ├── skills/                 # 6 SKILL.md folders (auto-discovered)
│       └── README.md               # plugin + skills conventions
├── package.json                    # npm workspaces root
├── .nvmrc                          # 24.15.0
├── .npmrc                          # engine-strict=true
├── README.md
└── LICENSE
```

---

## Development

Node 24 LTS required. Use a Node version manager and run `nvm use` (or `fnm use`) to activate the version pinned in `.nvmrc` before installing or running tests.

```bash
git clone git@github.com:evinops-hafla/hafla-intelligence-gateway.git
cd hafla-intelligence-gateway
nvm use                              # activate Node 24 LTS from .nvmrc
npm install                          # installs nothing today (zero deps) — sets up workspaces
npm test                             # runs each package's `npm test`
```

To smoke-test the bridge locally against the production gateway, you need to be in the `team@hafla.com` Workspace group with `isEmployeeActive=true` in `OpsUsers`:

```bash
cd packages/intelligence-mcp-bridge
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node src/index.js
```

The first line of stderr is a `Pre-flight OK` log; the response on stdout is a JSON-RPC `tools/list` reply listing the gateway's 23 read-only tools.

---

## Publishing (maintainers only)

The bridge publishes via npm with provenance (OIDC trusted publisher). See [packages/intelligence-mcp-bridge/CHANGELOG.md](packages/intelligence-mcp-bridge/CHANGELOG.md) for version history.

**Workflow: review-first, release-from-PR.** The version bump is reviewed *before* the irreversible `npm publish`, so the release commit rides the PR branch — it is **never** pushed straight to `main`. (This is what actually ships: every tag `v1.0.4`–`v1.0.7` sits on a PR **merge commit**, with the `chore(bridge): release` bump already inside the branch.) The internal Hafla `09-bridge-package-release-workflow-e375.md` spec is canonical and has the full gated sequence; the short form for maintainers:

```bash
# On the PR branch, AFTER the substantive change is green and review threads are
# resolved (ci.yml + gemini-code-assist[bot] have fired). Node 24.15.0 via .nvmrc.
nvm use
cd packages/intelligence-mcp-bridge
npm test                                                             # all tests must pass
npm pack --dry-run                                                   # confirm the files allowlist

# 1. Bump version WITHOUT npm's auto-commit + auto-tag (we orchestrate the commit):
npm version <patch|minor|major> --no-git-tag-version

# 2. CHANGELOG.md: rename [Unreleased] → [<version>] — <YYYY-MM-DD>; add a fresh empty [Unreleased].
# 3. Update EVERY version-pinned bridge ref (grep first: `git grep -n "intelligence-mcp-bridge@"`):
#      - this README's Packages table ("<version> — live on npm")
#      - the package README's install commands (`npm install -g …@<version>`)
#      - packages/plugin/.claude-plugin/plugin.json (mcpServers.args — the plugin RUNS the bridge via
#        `npx …@<version>`, so a stale pin ships a stale bridge to every plugin user)
# 4. Sync the workspace lockfile from the repo root:
cd ../.. && npm install --package-lock-only

# 5. ONE atomic release commit, APPENDED TO THE PR BRANCH (the bots re-review it):
git add packages/intelligence-mcp-bridge/package.json \
        packages/intelligence-mcp-bridge/CHANGELOG.md \
        README.md packages/intelligence-mcp-bridge/README.md \
        packages/plugin/.claude-plugin/plugin.json \
        package-lock.json
git commit -m "chore(bridge): release <version> — <one-line summary>"
git push                                                             # bot re-reviews the release commit

# 6. Merge the PR to main (--merge, keeps the 2-parent merge commit; never squash/rebase). Then:
git checkout main && git pull

# 7. Annotated tag ON THE MERGE COMMIT (MUST use -a; a lightweight tag is silently skipped by tooling).
#    Tag-staleness check: if anything landed on main since the merge, delete + recreate on HEAD first.
git tag -a v<version> -m "v<version>"
git push origin v<version>                                           # explicit — NOT --follow-tags

# 8. The tag push triggers release.yml → npm publish --provenance. Confirm:
gh run watch                                                         # CI publish green
npm view @hafla/intelligence-mcp-bridge@<version> version            # confirm on npm
```

The user-facing install / upgrade flow is in the package's own README — see [packages/intelligence-mcp-bridge/README.md](packages/intelligence-mcp-bridge/README.md).

---

## License

MIT — see [LICENSE](LICENSE).
