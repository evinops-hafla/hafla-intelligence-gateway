# Hafla Intelligence Gateway

Public client packages for the Hafla MCP Gateway at `mcp.hafla.com`.

This repo is the public side of the Hafla intelligence stack: small, audit-friendly packages that let Claude Code, Claude Desktop, Cursor, Gemini CLI, Antigravity CLI, and Antigravity 2.0 reach the gateway. The gateway server itself (data lakes, identity resolution, etc.) lives in a private monorepo.

---

## Two "gateways" — one convention to keep them straight

| Term                              | What                                                                                                           | Where                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **MCP Gateway** (server)          | Cloud Run service at `https://mcp.hafla.com` — IAM-gated HTTP MCP endpoint, AlloyDB + Neo4j + Vertex AI Search | private — separate repo |
| **Intelligence Gateway** (client) | Plugins, skills, agents, bridge — everything an employee installs to reach the MCP Gateway server              | this repo               |

Talk about "the MCP Gateway server" when you mean the Cloud Run service; "the Intelligence Gateway" when you mean this repo or the user-facing pieces in it.

---

## Packages

| Package                                                                  | Type                                      | Status                  |
| ------------------------------------------------------------------------ | ----------------------------------------- | ----------------------- |
| [`packages/intelligence-mcp-bridge/`](packages/intelligence-mcp-bridge/) | npm — `@hafla/intelligence-mcp-bridge`    | 1.0.6 — symlink-class regression fix + Antigravity CLI / 2.0 onboarding |
| `packages/plugin/`                                                       | Claude Code plugin / Gemini CLI extension | Planned                 |

### `@hafla/intelligence-mcp-bridge`

stdio↔HTTPS shim that mints Google ID tokens via the user's own `gcloud` and forwards JSON-RPC to `mcp.hafla.com`. Zero runtime dependencies.

**Install + configure:** [packages/intelligence-mcp-bridge/README.md](packages/intelligence-mcp-bridge/README.md) §§ "Prerequisites" and "3. Add this MCP server block to your client config". The package README is the canonical install reference — it covers the launchd-subprocess constraint (macOS GUI apps don't see your shell's `nvm`-managed binaries, so the MCP config requires two explicit absolute paths) and the per-version-manager path table (`nvm` / `fnm` / Volta / `nvm-windows`).

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
├── packages/
│   └── intelligence-mcp-bridge/    # @hafla/intelligence-mcp-bridge on npm
│       ├── src/index.js            # stdio↔HTTPS forwarder + token mint/cache
│       ├── src/version-check.js    # Node 24 LTS runtime guard
│       ├── tests/index.test.js     # node:test unit tests
│       ├── package.json
│       ├── README.md               # operator-facing install guide
│       ├── CHANGELOG.md
│       └── LICENSE                 # MIT (root LICENSE; the package symlinks via npm `files`)
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

The first line of stderr is a `Pre-flight OK` log; the response on stdout is a JSON-RPC `tools/list` reply with the 5 tools.

---

## Publishing (maintainers only)

The bridge publishes via npm with provenance (OIDC trusted publisher). See [packages/intelligence-mcp-bridge/CHANGELOG.md](packages/intelligence-mcp-bridge/CHANGELOG.md) for version history.

**Workflow:** review-first, release-from-main. Open a PR with the substantive change (do NOT bump `version` or finalize a versioned CHANGELOG entry on the chore branch); let `ci.yml` + `gemini-code-assist[bot]` review fire; address findings; merge; then run the release sequence below ON `main`. The internal Hafla `09-bridge-package-release-workflow-e375.md` spec has the full gated sequence; the short form for maintainers is:

```bash
# After merging to main and pulling locally:
nvm use                                                              # picks up .nvmrc → 24.15.0
cd packages/intelligence-mcp-bridge
npm test                                                             # all tests must pass
npm pack --dry-run                                                   # confirm tarball contents

# 1. Bump version WITHOUT npm's auto-commit + auto-tag (we orchestrate the atomic commit ourselves):
npm version <patch|minor|major> --no-git-tag-version

# 2. Edit CHANGELOG.md: rename [Unreleased] → [<version>] — <YYYY-MM-DD>; add a fresh empty [Unreleased] above.

# 3. Sync the root workspace lockfile from intelligence-gateway/ root:
cd ../..
npm install --package-lock-only

# 4. Atomic release commit (one commit containing version + CHANGELOG + lockfile sync):
git add packages/intelligence-mcp-bridge/package.json \
        packages/intelligence-mcp-bridge/CHANGELOG.md \
        package-lock.json
git commit -m "chore(bridge): release <version> — <one-line summary>"

# 5. Annotated tag (MUST use -a; plain `git tag` creates a lightweight tag
#    that `git push --follow-tags` silently skips):
git tag -a v<version> -m "v<version>"

# 6. Push branch + tag together → triggers release.yml → npm publish:
git push --follow-tags
gh run watch                                                         # confirm CI publish green
npm view @hafla/intelligence-mcp-bridge@<version> version            # confirm on npm
```

The user-facing install / upgrade flow is in the package's own README — see [packages/intelligence-mcp-bridge/README.md](packages/intelligence-mcp-bridge/README.md).

---

## License

MIT — see [LICENSE](LICENSE).
