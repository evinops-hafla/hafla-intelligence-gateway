# @hafla/intelligence-mcp-bridge

A small stdio↔HTTPS shim that lets Claude Code, Claude Desktop, Cursor, and Gemini CLI reach the **Hafla MCP Gateway** at `mcp.hafla.com`.

The bridge mints a fresh 60-minute Google ID token via your own `gcloud` session, caches it, refreshes it ~55 minutes before expiry, and forwards every JSON-RPC request to the gateway with a `Bearer` header. No shared secret, no per-user token to issue or rotate — authorisation is your Google Workspace identity.

---

## Prerequisites

### Node 24 LTS

This bridge requires **Node 24 LTS** (currently `24.15.0` or any newer patch in the 24.x line).

We strongly recommend installing Node via a version manager rather than the OS installer — switching versions and applying security patches becomes a one-liner.

- **macOS / Linux:** [`nvm`](https://github.com/nvm-sh/nvm) (recommended) or [`fnm`](https://github.com/Schniz/fnm)
- **Windows:** [`fnm`](https://github.com/Schniz/fnm) (recommended, cross-platform) or [`nvm-windows`](https://github.com/coreybutler/nvm-windows)

All four respect the `.nvmrc` file in the project, so once your manager is installed:

```bash
nvm install # or: fnm install
nvm use # or: fnm use
node -v # should print v24.15.x
```

Then install and run the bridge (pinned version — see CHANGELOG for the current release):

```bash
npx -y @hafla/intelligence-mcp-bridge@1.0.3
```

Access is gated at the gateway (`mcp.hafla.com`) against the Hafla Google Workspace org — the npm package is a distribution channel, not the trust boundary.

### Workspace access

Ops must have done two one-time things for you:

1. Added you to the `team@hafla.com` Google Workspace group.
2. Flagged your account `isEmployeeActive=true` in `haflaCore.OpsUsers`.

If you have not received confirmation from Ops, the bridge will start, but the gateway will return `403 employee_inactive` on the first request.

---

## Install — 3 steps

### 1. Install the Google Cloud SDK (one-time, skip if you already have `gcloud`)

| OS          | Command                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | `brew install --cask google-cloud-sdk`                                                                                                                                                                        |
| **Windows** | `winget install Google.CloudSDK` &nbsp;_(or)_ `choco install gcloudsdk` &nbsp;_(or)_ download the installer at [cloud.google.com/sdk/docs/install#windows](https://cloud.google.com/sdk/docs/install#windows) |
| **Linux**   | Follow [cloud.google.com/sdk/docs/install#linux](https://cloud.google.com/sdk/docs/install#linux)                                                                                                             |

### 2. Sign in with your `@hafla.com` account

```bash
gcloud auth login                              # browser opens → log in with @hafla.com
gcloud config set account <you>@hafla.com      # only needed if you have other gcloud accounts
gcloud auth list                               # confirm @hafla.com row shows "*"
```

The bridge's pre-flight rejects any non-`@hafla.com` active account before sending traffic, so the `gcloud config set account` step matters if you already use `gcloud` for personal projects.

### 3. Add this MCP server block to your client config

The JSON block is identical on every OS — only the file path differs.

| Client                       | Config file (macOS / Linux)                                       | Config file (Windows)                         |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| Claude Code                  | `~/.claude.json`                                                  | `%USERPROFILE%\.claude.json`                  |
| Claude Code (project-scoped) | `<project>/.mcp.json`                                             | `<project>\.mcp.json`                         |
| Claude Desktop               | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| Gemini CLI                   | `~/.gemini/settings.json`                                         | `%USERPROFILE%\.gemini\settings.json`         |

Add (or replace) the `hafla-evwa-idl-gateway` block under `mcpServers`:

```json
{
  "mcpServers": {
    "hafla-evwa-idl-gateway": {
      "command": "/Users/YOU/.nvm/versions/node/v24.15.0/bin/node",
      "args": ["-e", "import('@hafla/intelligence-mcp-bridge@1.0.3')"]
    }
  }
}
```

**Replace `/Users/YOU/.nvm/versions/node/v24.15.0/bin/node`** with the path printed by `which node` after running `nvm use` (or `fnm use`) in your terminal.

> **Fragility note — read before configuring.** The `command` path is hardcoded to your version manager's install location. This path is OS- and manager-specific:
> - **nvm (macOS/Linux):** `~/.nvm/versions/node/v24.15.0/bin/node`
> - **Volta (macOS/Linux):** `~/.volta/tools/image/node/24.15.0/bin/node`
> - **fnm (macOS/Linux):** `~/.fnm/node-versions/v24.15.0/installation/bin/node`
> - **nvm-windows:** `%APPDATA%\nvm\v24.15.0\node.exe`
>
> **On any Node minor/patch upgrade or version-manager reinstall, you MUST update this path in your MCP client config.** If the path drifts, the bridge silently fails to spawn, surfacing only as "MCP server disconnected" in the client with no actionable error chain.
>
> Why hardcode instead of using `"command": "npx"`? On macOS, GUI apps (Claude Desktop) inherit their environment from launchd — not your shell's `~/.zshrc`. `npx` is NOT on the launchd PATH even when you did everything right with nvm. Wrapper scripts that `source ~/.nvm/nvm.sh` add their own failure modes on path/version upgrades. Hardcoding the absolute path with a documented upgrade ritual is the least-bad option.

Restart the MCP client. Done.

---

## What tools you get

Five read-only tools, all backed by Hafla's data lakes + identity layer (live at `mcp.hafla.com`):

| Tool                        | What it does                                                     |
| --------------------------- | ---------------------------------------------------------------- |
| `safe_sql_sandbox`          | Parameterised read-only AlloyDB SQL across all lakes             |
| `safe_cypher_sandbox`       | Parameterised read-only Neo4j Cypher over the identity graph     |
| `analyze_identity_graph`    | Cross-lake identity resolution — one unified profile per person  |
| `get_ticket_360`            | Full Zendesk ticket with linked WhatsApp chats and Slack threads |
| `search_internal_knowledge` | Semantic search over the WhatsApp / Slack conversation corpus    |

All five are read-only at the database layer — the bridge cannot write.

---

## Verify

Restart your client and ask it:

> Run `safe_sql_sandbox` with `SELECT COUNT(*) FROM "haflaCore"."OpsUsers"`.

A row count comes back, you're done. The very first request takes ~1–2 s longer while the bridge mints your first Google ID token; subsequent calls reuse the cached token.

---

## Troubleshooting

The bridge writes actionable diagnostic banners to stderr. Where you see "MCP client logs" below, that's:

- **Claude Code / Claude Desktop:** the client's own log file (varies by OS — check the client's documentation)
- **Gemini CLI:** the terminal where you launched the client

| Symptom / banner                                                      | Cause                                                               | Fix                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requires Node 24 LTS (you are on vXX.X.X)`                          | Node version is not 24.x                                            | Install Node 24 LTS via a version manager (see Prerequisites above). After `nvm use`, update the `command` path in your MCP client config to the new `which node` output.                                                                                                                           |
| `gcloud CLI not found`                                                | Google Cloud SDK isn't installed (or not on PATH)                   | Re-run the install command from Step 1. On Windows, may need a restart for PATH to take effect.                                                                                                                                                                                                     |
| `Active gcloud account is X — must be an @hafla.com account`          | You're logged into `gcloud` with a personal account                 | `gcloud config set account <you>@hafla.com` — then `gcloud auth list` to confirm the `*` is on your @hafla.com row. If your @hafla.com account is missing, `gcloud auth login` first.                                                                                                               |
| `gateway returned 401 — token audience likely mismatched`             | Cloud Run edge rejected the token                                   | Most common cause: you're not yet in the `team@hafla.com` Google Group — ping Ops. Less common: the gateway deploy is missing `https://mcp.hafla.com` in `customAudiences` — that's an Ops fix. Sometimes a cached token pre-dates your group add — re-run `gcloud auth login` to mint a fresh one. |
| `gateway returned 403 employee_inactive`                              | You're in the group but not active in OpsUsers                      | Ping Ops to set `isEmployeeActive=true` on your `haflaCore.OpsUsers` row.                                                                                                                                                                                                                           |
| `Failed to mint Google ID token`                                      | `gcloud` could not produce an identity token                        | Usual causes (the banner lists them): (1) credentials expired → `gcloud auth login`; (2) wrong active project → `gcloud config get-value project`; (3) older gcloud SDK → `gcloud components update`.                                                                                               |
| Silent failure / no response in the client                            | MCP client cannot spawn the bridge                                  | Confirm the `command` path in your MCP config is the correct absolute path to `node` — run `which node` after `nvm use` and compare. Requires **Node 24 LTS**. To get more diagnostics, add `"env": { "DEBUG": "1" }` to the server block and tail the MCP client's log.                           |
| **(Windows)** `gcloud CLI not found` even though gcloud is installed  | gcloud's `bin/` isn't on PATH (the installer doesn't always add it) | In PowerShell: `where.exe gcloud`. If empty, add `%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\` to PATH via **System → Environment Variables**, then restart the MCP client.                                                                                                               |
| **(Windows)** MCP client fails to spawn the bridge — no stderr at all | Hardcoded `command` path is stale or incorrect                      | In PowerShell: run `fnm use` then `where.exe node` and update the `command` path in your MCP config to match. The bridge requires **Node 24 LTS**.                                                                                                                                                  |

---

## Upgrading

Because `npx -y @hafla/intelligence-mcp-bridge@1.0.3` is **pinned to an exact version**, npm caches that specifier under `~/.npm/_npx/<hash>/` and keeps re-using the cached copy across restarts. New versions ship via three steps:

1. Edit the `args` in your `.mcp.json` / `settings.json` to the new version, e.g. `"@hafla/intelligence-mcp-bridge@1.0.4"`.
2. Restart the MCP client.
3. `npx` pulls the new tarball on first invocation; the previous cache entry stays put under the old hash.

Optional: `npx clear-npx-cache` or remove `~/.npm/_npx/<hash>/` if you want to force a re-download for the same version.

**Do not switch to `@latest`** — pinning is the supply-chain hygiene boundary. Ops announces every version bump in Slack so the team can update on their own cadence.

---

## What this bridge does NOT do

- Store credentials of any kind. It runs as your user, uses your gcloud session.
- Open inbound ports. It's stdio↔HTTPS, the client launches it on demand.
- Write to anything. Authorisation at the gateway is read-only; SQL/Cypher writes are rejected at the database layer.
- Contact a server other than `https://mcp.hafla.com` (unless you override `GATEWAY_URL` for local dev).

---

## License

MIT — see [LICENSE](./LICENSE).
