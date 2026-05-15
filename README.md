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
| [`packages/intelligence-mcp-bridge/`](packages/intelligence-mcp-bridge/) | npm — `@hafla/intelligence-mcp-bridge` | 1.0.0 — initial release |
| `packages/plugin/`                                                     | Claude Code plugin / Gemini CLI extension | Planned                 |

### `@hafla/intelligence-mcp-bridge`

stdio↔HTTPS shim that mints Google ID tokens via the user's own `gcloud` and forwards JSON-RPC to `mcp.hafla.com`. Zero runtime dependencies. See [packages/intelligence-mcp-bridge/README.md](packages/intelligence-mcp-bridge/README.md) for install instructions for engineers and the CRM team.

```json
{
  "mcpServers": {
    "hafla-evwa-idl-gateway": {
      "command": "npx",
      "args": ["-y", "@hafla/intelligence-mcp-bridge@1.0.0"]
    }
  }
}
```

---

## Repo layout

```text
intelligence-gateway/
├── packages/
│   └── intelligence-mcp-bridge/    # @hafla/intelligence-mcp-bridge on npm
│       ├── src/index.js            # stdio↔HTTPS forwarder + token mint/cache
│       ├── tests/index.test.js     # node:test unit tests
│       ├── package.json
│       ├── README.md               # operator-facing install guide
│       ├── CHANGELOG.md
│       └── LICENSE                 # MIT (root LICENSE; the package symlinks via npm `files`)
├── package.json                    # npm workspaces root
├── README.md
└── LICENSE
```

---

## Development

Node ≥20 required (the bridge supports anything from 20 upwards; the workspaces root pins the same minimum).

```bash
git clone git@github.com:evinops-hafla/hafla-intelligence-gateway.git
cd hafla-intelligence-gateway
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

The bridge publishes via npm with provenance (OIDC trusted publisher recommended; manual `npm publish` works too):

```bash
cd packages/intelligence-mcp-bridge
npm pack --dry-run                   # confirm tarball contents
npm test                             # green
npm version <patch|minor|major>      # bumps version + creates a git tag
npm publish                          # publishConfig handles --access public + provenance
git push --follow-tags
```

See the package's own README for the user-facing install / upgrade flow.

---

## License

MIT — see [LICENSE](LICENSE).
