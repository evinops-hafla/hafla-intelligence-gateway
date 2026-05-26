# `@hafla/intelligence-mcp-bridge`

A small stdio↔HTTPS shim that lets **Claude Code, Claude Desktop, Cursor, Gemini CLI, Antigravity CLI, and Antigravity 2.0** reach the **Hafla MCP Gateway** at `mcp.hafla.com`.

The bridge mints a fresh 60-minute Google ID token via your own `gcloud` session, caches it, refreshes it ~55 minutes before expiry, and forwards every JSON-RPC request to the gateway with a `Bearer` header. No shared secret, no per-user token to issue or rotate — authorisation is your Google Workspace identity.

---

## TL;DR

Prerequisites are in [PREREQUISITES.md](./PREREQUISITES.md). If those are met:

```bash
npm install -g @hafla/intelligence-mcp-bridge@1.0.6
```

Add this to your MCP client config (Gemini CLI / Claude Code / Cursor / Antigravity CLI):

```json
{
  "mcpServers": {
    "hafla-evwa-idl-gateway": {
      "command": "intelligence-mcp-bridge",
      "trust": true
    }
  }
}
```

`"trust": true` suppresses the per-tool-call confirmation prompt that Gemini CLI / Antigravity CLI raise on every invocation (5 tools × many calls per session — unusable without it). Claude Code / Claude Desktop / Cursor ignore the unknown field; no harm to add.

Restart your MCP client. Done.

---

## Prerequisites verify

Before the install playbook below, confirm these seven checks pass. If any fail, complete the setup in [PREREQUISITES.md](./PREREQUISITES.md).

| Check                                | Command                                  | Expected output                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24 LTS active                   | `node -v`                                | `v24.15.0` or newer `v24.x.y`                                                                                                                                                         |
| npm recent                           | `npm -v`                                 | `11.x` or newer                                                                                                                                                                       |
| Version manager (Windows)            | `nvm version`                            | A version string (e.g. `1.1.12`)                                                                                                                                                      |
| Version manager (macOS)              | `command -v nvm`                         | `nvm` (a shell function)                                                                                                                                                              |
| Node-managed MCP client on Node 24   | `gemini --version` or `claude --version` | Version string, no `EBADENGINE` warning. Skip if you only use non-Node-managed clients (Cursor / Claude Desktop / Antigravity CLI / Antigravity 2.0).                                 |
| Antigravity CLI (if using)           | `agy --version`                          | Version string. `agy` is not Node-managed (installed via Google curl/PowerShell script); `EBADENGINE` is not possible.                                                                |
| gcloud SDK installed                 | `gcloud --version`                       | Prints SDK version                                                                                                                                                                    |
| `@hafla.com` active in gcloud        | `gcloud auth list`                       | An `ACTIVE` row matching your `@hafla.com` email                                                                                                                                      |

All pass → proceed below.

---

## Install playbook

### Step 1 — Install the bridge

```bash
npm install -g @hafla/intelligence-mcp-bridge@1.0.6
```

The version is **exact-pinned** (`@1.0.6`, not `@latest`). Pinning is the supply-chain hygiene boundary; Ops announces version bumps in Slack so the team upgrades on a known cadence. See § "Upgrading" below.

### Step 2 — Verify install

Confirm the `intelligence-mcp-bridge` bin shim resolves on your PATH:

| OS                   | Command                             |
| -------------------- | ----------------------------------- |
| macOS                | `which intelligence-mcp-bridge`     |
| Windows (PowerShell) | `where.exe intelligence-mcp-bridge` |

Expected: **one or more** absolute paths. Example on macOS: `/Users/YOU/.nvm/versions/node/v24.15.0/bin/intelligence-mcp-bridge`. Example on Windows: `C:\Users\YOU\AppData\Roaming\nvm\v24.15.0\intelligence-mcp-bridge.cmd` (you may also see the bare `intelligence-mcp-bridge` and/or `.ps1` siblings — npm creates a small shim family per global install). **Prefer the `.cmd` path on Windows** if multiple are listed; `.ps1` can be blocked by PowerShell ExecutionPolicy.

If empty: reinstall (Step 1) or check that PATH was refreshed in the current shell session.

### Step 3 — Back up your MCP client config (if it exists)

The MCP client config file holds your other MCP servers. Before editing it, back it up.

Pick your client's config file:

| Client                                  | macOS / Linux                                                     | Windows                                                  |
| --------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Gemini CLI                              | `~/.gemini/settings.json` (+ `<project>/.gemini/settings.json`)   | `%USERPROFILE%\.gemini\settings.json` (+ project-scoped) |
| Claude Code (project-scoped)            | `<project>/.mcp.json`                                             | `<project>\.mcp.json`                                    |
| Claude Code (user-scoped)               | `~/.claude.json`                                                  | `%USERPROFILE%\.claude.json`                             |
| Claude Desktop                          | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json`            |
| Cursor                                  | `~/.cursor/mcp.json`                                              | `%USERPROFILE%\.cursor\mcp.json`                         |
| Antigravity CLI (CLI-only) [^agycli]    | `~/.gemini/antigravity-cli/settings.json`                         | `%USERPROFILE%\.gemini\antigravity-cli\settings.json`    |
| Antigravity CLI + 2.0 (shared) [^agycli] | `~/.gemini/config/mcp_config.json`                                | `%USERPROFILE%\.gemini\config\mcp_config.json`           |
| Antigravity 2.0                         | `~/.gemini/antigravity/mcp_config.json`                           | `%USERPROFILE%\.gemini\antigravity\mcp_config.json`      |

[^agycli]: **Antigravity CLI has two valid config paths.** Pick **CLI-only** if you don't use Antigravity 2.0. Pick **shared** if you use both products and want one source of truth for `mcpServers`. Both work; both are read by `agy`. Note that Gemini CLI and Antigravity CLI both also read project-scoped settings from `<project>/.gemini/settings.json` (cascades over the global file — useful for repo-specific overrides).

**If the file exists**, back it up with a date-time suffix:

| OS                   | Command (substitute your client's path)                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                | `cp "$HOME/.gemini/settings.json" "$HOME/.gemini/settings.json.bak.$(date +%Y%m%d-%H%M%S)"`                                             |
| Windows (PowerShell) | `Copy-Item "$env:USERPROFILE\.gemini\settings.json" "$env:USERPROFILE\.gemini\settings.json.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"` |

**If the file does not exist** (fresh machine): skip the backup, but ensure the parent directory exists before Step 4 (some editors won't auto-create it on save):

| OS                   | Command                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| macOS                | `mkdir -p ~/.gemini` (substitute your client's parent dir)                   |
| Windows (PowerShell) | `New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini" \| Out-Null` |

Step 4 then creates the config file with your MCP block.

### Step 4 — Configure your MCP client

Two forms supported. **Try Form A first** — it's strictly simpler and works for most clients.

#### Form A — bin shim (recommended)

Works for any client that resolves bare commands via the user's shell PATH: **Gemini CLI, Claude Code (CLI), Cursor, Antigravity CLI**.

```json
{
  "mcpServers": {
    "hafla-evwa-idl-gateway": {
      "command": "intelligence-mcp-bridge",
      "trust": true
    }
  }
}
```

No embedded path. PATH lookup resolves `intelligence-mcp-bridge.cmd` on Windows and `intelligence-mcp-bridge` on macOS automatically. No JSON-escape concerns. `"trust": true` suppresses per-tool-call confirmation prompts in Gemini CLI / Antigravity CLI (load-bearing UX); clients that don't recognise the field ignore it (no harm). **The MCP config text stays stable across bridge upgrades and Node upgrades — you do NOT have to edit this JSON.** But if you change Node versions via nvm (including patch upgrades like `nvm install 24.16.0 && nvm use 24.16.0`), you must **reinstall the bridge under the new Node** (see [Step 1](#step-1--install-the-bridge)) — nvm isolates global packages per Node version, so the old install becomes invisible until you reinstall.

**Windows fallback:** if your MCP client logs "MCP server disconnected" with the bare `"command": "intelligence-mcp-bridge"`, the client's subprocess spawn may not apply Windows `PATHEXT` resolution. Add the `.cmd` suffix explicitly:

```json
{
  "mcpServers": {
    "hafla-evwa-idl-gateway": {
      "command": "intelligence-mcp-bridge.cmd",
      "trust": true
    }
  }
}
```

If `intelligence-mcp-bridge.cmd` still doesn't spawn (some clients use raw `CreateProcess` and cannot execute `.cmd` files without `cmd.exe /c`), switch to **Form B** below.

If you're editing an existing config that already has `mcpServers`, add the `hafla-evwa-idl-gateway` block as a peer to your existing entries — don't replace the file.

#### Form B — absolute paths (fallback)

Use ONLY when Form A doesn't work. This is typically because the client spawns subprocesses without inheriting your user shell PATH:

- **Claude Desktop** (launchd on macOS / service spawn on Windows — does NOT inherit shell PATH)
- **Antigravity 2.0** (desktop app — may also not inherit shell PATH on macOS, same launchd class as Claude Desktop; verify by first trying Form A, fall back to Form B if Form A logs "MCP server disconnected")

**Derive your paths** (run on your machine; do NOT copy from an example):

| OS                   | Path A (node)                | Path B (bridge entrypoint)                                          |
| -------------------- | ---------------------------- | ------------------------------------------------------------------- |
| macOS                | `node -p "process.execPath"` | `echo "$(npm root -g)/@hafla/intelligence-mcp-bridge/src/index.js"` |
| Windows (PowerShell) | `node -p "process.execPath"` | `echo "$(npm root -g)\@hafla\intelligence-mcp-bridge\src\index.js"` |

`node -p "process.execPath"` returns the absolute path to the Node binary that is _currently_ executing — single value, deterministic, identical syntax across both OSes. Avoids the `which node` / `where.exe node` multi-line ambiguity when multiple Node installs exist.

**Confirm Path B exists** before pasting into JSON (catches half-installed state — e.g., bridge installed under a different Node version than the one currently active):

| OS                   | Command                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| macOS                | `if test -f "$(npm root -g)/@hafla/intelligence-mcp-bridge/src/index.js"; then echo OK; else echo "NOT FOUND"; fi` |
| Windows (PowerShell) | `Test-Path "$(npm root -g)\@hafla\intelligence-mcp-bridge\src\index.js"`                                           |

Expected: `OK` (macOS) or `True` (Windows). If `NOT FOUND` (macOS) / `False` (Windows), the bridge is not installed under your active Node — go back to [Step 1](#step-1--install-the-bridge) and reinstall the bridge.

**Windows-specific JSON-syntax rules:**

1. **Backslash escape.** Windows paths contain `\` — JSON requires every `\` doubled to `\\`, OR convert all to forward slashes `/`. Example: `C:\Users\YOU\node.exe` → `"C:\\Users\\YOU\\node.exe"` or `"C:/Users/YOU/node.exe"`.
2. **Executable suffix.** Use the full filename including suffix: `node.exe` (not `node`). `node -p "process.execPath"` returns the full path with suffix automatically; do not hand-strip it.
3. **Verify Path A actually spawns** BEFORE pasting into JSON. In PowerShell:

   ```powershell
   & "C:\path\you\derived\node.exe" --version
   ```

   If it errors with `ENOENT` or "not recognized", the path is wrong — re-derive via `node -p "process.execPath"`.

**MCP block (Form B):**

```json
{
  "mcpServers": {
    "hafla-evwa-idl-gateway": {
      "command": "<Path A>",
      "args": ["<Path B>"],
      "trust": true
    }
  }
}
```

### Step 5 — Reload your MCP client + end-to-end verify

Restart the client (close + reopen for desktop apps; `exit` + relaunch for CLI apps).

**Gemini CLI users — what to expect on first launch:** Gemini CLI may show two prompts the bridge cannot suppress:

1. **Folder Trust prompt** — Gemini CLI asks you to trust the current workspace folder. Click **Trust folder**. Without this, MCP servers (including this bridge) won't load.
2. **Second Google sign-in** — Gemini CLI's own OAuth scope is separate from the `gcloud auth login` you completed in PREREQUISITES. Sign in again with your `@hafla.com` Google account. The bridge still uses the gcloud-minted token for `mcp.hafla.com` calls; this second sign-in is purely Gemini-CLI-side and typically only needed once (Gemini CLI may re-prompt later if its own OAuth token expires or its scope changes).

Both prompts are expected Gemini CLI behaviors, not bridge errors.

Then ask the client:

> Run `safe_sql_sandbox` with `SELECT COUNT(*) FROM "haflaCore"."OpsUsers"`.

A row count comes back, you're done. The first request takes ~1–2 s longer while the bridge mints your first Google ID token; subsequent calls reuse the cached token.

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

## Troubleshooting

Diagnostic banners are written to stderr. The "literal stderr" column gives the exact text to grep against.

| Symptom                          | Literal stderr (grep target)                                    | Cause                                                | Fix                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Wrong Node version               | `requires Node 24 LTS (you are on v...)`                        | Node ≠ 24.x                                          | `nvm use 24.15.0`. If on Form B, also re-derive Path A (Node binary path may have moved).                                      |
| gcloud not found                 | `gcloud CLI not found`                                          | Not installed or PATH issue                          | Run the gcloud step from [PREREQUISITES.md](./PREREQUISITES.md) (Windows Step 4 / macOS Step 5).                               |
| Wrong gcloud account             | `Active gcloud account is X — must be an @hafla.com account`    | Personal account active                              | `gcloud config set account YOU@hafla.com`; verify with `gcloud auth list`.                                                     |
| 401 audience mismatch            | `gateway returned 401 — token audience likely mismatched`       | Not in `team@hafla.com` Workspace group              | Ping Ops to be added. If you ARE in the group, run `gcloud auth login` to mint a fresh token.                                  |
| 403 employee inactive            | `gateway returned 403 employee_inactive`                        | `haflaCore.OpsUsers` row not active                  | Ping Ops to set `isEmployeeActive=true` on your row.                                                                           |
| Token mint failure               | `Failed to mint Google ID token`                                | Credentials expired or SDK stale                     | `gcloud auth login` to re-authenticate; `gcloud components update` to refresh the SDK.                                         |
| Silent disconnect                | (no bridge banner — client log shows "MCP server disconnected") | bin shim not on PATH (Form A) or wrong path (Form B) | Re-run Step 2 verify. If Form A bin shim doesn't resolve, switch to Form B. If Form B path is wrong, re-derive on the machine. |
| Windows: PowerShell script error | `running scripts is disabled on this system`                    | PowerShell ExecutionPolicy blocks `.ps1` shims       | Invoke the `.cmd` wrapper directly: `intelligence-mcp-bridge.cmd` (works regardless of `ExecutionPolicy`).                     |

---

## Upgrading

The version specifier is **exact-pinned**. Every release announcement (Slack `#engineering`) cites a version number (e.g. `1.0.7`) and a link to the CHANGELOG entry — read it before upgrading.

### Step 1 — Read the CHANGELOG

Open [CHANGELOG.md](./CHANGELOG.md) and read the entry for the new version. Look for:

- **Breaking changes** — anything in a `### Breaking` or `### Removed` section. May require a config edit, not just a version bump.
- **Security fixes** — anything in `### Security`. Non-optional even if the rest of the release is.
- **New features** — anything in `### Added`. Some require opting in via env var or config flag.

### Step 2 — Backup your MCP client config

Before touching anything, snapshot the files you'll edit. Pick your client's config file from the [Step 3 table](#step-3--back-up-your-mcp-client-config-if-it-exists) and:

| OS                   | Command (substitute your client's path)                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                | `cp "$HOME/.gemini/settings.json" "$HOME/.gemini/settings.json.bak.$(date +%Y%m%d-%H%M%S)"`                                             |
| Windows (PowerShell) | `Copy-Item "$env:USERPROFILE\.gemini\settings.json" "$env:USERPROFILE\.gemini\settings.json.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"` |

### Step 3 — Reinstall the bridge

```bash
npm uninstall -g @hafla/intelligence-mcp-bridge
npm install -g @hafla/intelligence-mcp-bridge@<new-version>
```

### Step 4 — Restart your MCP client

The bridge is a child process of the MCP client; the client only re-spawns it on full restart.

- **Claude Code:** quit and relaunch from your terminal
- **Claude Desktop:** quit (Cmd-Q on macOS, Alt-F4 on Windows) and reopen
- **Gemini CLI / Antigravity CLI:** exit your current session and start a new one
- **Antigravity 2.0:** quit and reopen the agent-builder app
- **Cursor:** Cmd-Q / Alt-F4 and reopen

### Step 5 — Verify the new version is running

In your MCP client, invoke one tool from the gateway — `safe_sql_sandbox` with `SELECT 1` works. If the tool responds normally, the new version is running.

If you get "MCP server disconnected" or an empty tool list, see [Troubleshooting](#troubleshooting).

### Form-specific notes

**Form A users:** no config edit needed across **bridge** upgrades — the bin shim resolves to the new version automatically. If you also changed Node versions via nvm (any change, including patch upgrades like `nvm install 24.16.0 && nvm use 24.16.0`), reinstall the bridge first (`npm install -g @hafla/intelligence-mcp-bridge@<new-version>`) under the new Node; nvm isolates global packages per Node version.

**Form B users:** re-derive **both** Path A (`node -p "process.execPath"`) and Path B (`$(npm root -g)/...` or `$(npm root -g)\...`). When Node version changes under nvm, both the binary path AND the global node_modules root move. Reinstall the bridge under the new Node first; then update both paths in your MCP config.

**Do not switch to `@latest`** — pinning is the supply-chain hygiene boundary. Ops announces every version bump in Slack so the team can update on its own cadence.

---

## What this bridge does NOT do

- Store credentials of any kind. It runs as your user and uses your `gcloud` session.
- Open inbound ports. It's stdio↔HTTPS; the client launches it on demand.
- Write to anything. Authorisation at the gateway is read-only; SQL/Cypher writes are rejected at the database layer.
- Contact a server other than `https://mcp.hafla.com` (unless you override `GATEWAY_URL` for local dev).

---

## License

MIT — see [LICENSE](./LICENSE).
