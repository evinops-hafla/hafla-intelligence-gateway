# Hafla Intelligence Gateway

Public client packages for the Hafla MCP Gateway at `mcp.hafla.com`.

This repo is the public side of the Hafla intelligence stack: small, audit-friendly packages that let Claude Code, Claude Desktop, Cursor, and Gemini CLI reach the gateway. The gateway server itself (data lakes, identity resolution, etc.) lives in a private monorepo.

---

## Two "gateways" — one convention to keep them straight

| Term                              | What                                                                                                              | Where                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **MCP Gateway** (server)          | Cloud Run service at `https://mcp.hafla.com` — IAM-gated HTTP MCP endpoint, AlloyDB + Neo4j + Vertex AI Search   | private — separate repo          |
| **Intelligence Gateway** (client) | Plugins, skills, agents, bridge — everything an employee installs to reach the MCP Gateway server                 | this repo                        |

Talk about "the MCP Gateway server" when you mean the Cloud Run service; "the Intelligence Gateway" when you mean this repo or the user-facing pieces in it.

---

## Packages

| Package                                                                | Type         | Status                  |
| ---------------------------------------------------------------------- | ------------ | ----------------------- |
| [`packages/intelligence-mcp-bridge/`](packages/intelligence-mcp-bridge/) | npm — `@hafla/intelligence-mcp-bridge` | 1.0.3 — Node 24 LTS pin |
| `packages/plugin/`                                                     | Claude Code plugin / Gemini CLI extension | Planned                 |

### `@hafla/intelligence-mcp-bridge`

stdio↔HTTPS shim that mints Google ID tokens via the user's own `gcloud` and forwards JSON-RPC to `mcp.hafla.com`. Zero runtime dependencies. See [packages/intelligence-mcp-bridge/README.md](packages/intelligence-mcp-bridge/README.md) for install instructions.

```json
{
  "mcpServers": {
    "hafla-evwa-idl-gateway": {
      "command": "/path/to/node-version-manager/node",
      "args": ["-e", "require('child_process').execFileSync(require('path').join(require('os').homedir(), '.npm', '_npx', 'HASH', 'node_modules', '.bin', 'intelligence-mcp-bridge'), { stdio: 'inherit' })"]
    }
  }
}
```

See the package README § "Prerequisites" for the correct `command` path and the full client config snippet.

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

The bridge publishes via npm with provenance (OIDC trusted publisher recommended; manual `npm publish` works too). See [packages/intelligence-mcp-bridge/CHANGELOG.md](packages/intelligence-mcp-bridge/CHANGELOG.md) for the current release and version history.

```bash
# From hafla-intelligence/ monorepo root — use the node24-pin-plan.md release workflow
npx -y @hafla/intelligence-mcp-bridge@1.0.3
```

See the package's own README for the user-facing install / upgrade flow.

---

## License

MIT — see [LICENSE](LICENSE).
