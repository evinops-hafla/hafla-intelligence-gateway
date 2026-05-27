# `@hafla/intelligence-mcp-bridge`

**Status:** Production (1.0.7 — see [CHANGELOG.md](./CHANGELOG.md)).

A small stdio↔HTTPS shim that lets **Claude Code, Claude Desktop, Cursor, Gemini CLI, Antigravity CLI, and Antigravity 2.0** reach the **Hafla MCP Gateway** at `mcp.hafla.com`.

The bridge mints a fresh 60-minute Google ID token via your own `gcloud` session, caches it, refreshes it ~55 minutes before expiry, and forwards every JSON-RPC request to the gateway with a `Bearer` header. No shared secret, no per-user token to issue or rotate — authorisation is your Google Workspace identity.

---

## TL;DR

Prerequisites are in [PREREQUISITES.md](./PREREQUISITES.md). If those are met:

```bash
npm install -g @hafla/intelligence-mcp-bridge@1.0.7
```

Add this to your MCP client config (Gemini CLI / Claude Code / Cursor / Antigravity CLI). **Antigravity 2.0 and Claude Desktop need [Form B](#form-b--absolute-paths-fallback) instead** — they're desktop apps that don't inherit shell PATH:

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

Before the install playbook below, confirm these checks pass. If any fail, complete the setup in [PREREQUISITES.md](./PREREQUISITES.md).

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
npm install -g @hafla/intelligence-mcp-bridge@1.0.7
```

The version is **exact-pinned** (`@1.0.7`, not `@latest`). Pinning is the supply-chain hygiene boundary; Ops announces version bumps in Slack so the team upgrades on a known cadence. See § "Upgrading" below.

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

| Client                                   | macOS / Linux                                                     | Windows                                                  |
| ---------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Gemini CLI                               | `~/.gemini/settings.json` (+ `<project>/.gemini/settings.json`)   | `%USERPROFILE%\.gemini\settings.json` (+ project-scoped) |
| Claude Code (project-scoped)             | `<project>/.mcp.json`                                             | `<project>\.mcp.json`                                    |
| Claude Code (user-scoped)                | `~/.claude.json`                                                  | `%USERPROFILE%\.claude.json`                             |
| Claude Desktop                           | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json`            |
| Cursor                                   | `~/.cursor/mcp.json`                                              | `%USERPROFILE%\.cursor\mcp.json`                         |
| Antigravity CLI (CLI-only) [^agycli]     | `~/.gemini/antigravity-cli/settings.json`                         | `%USERPROFILE%\.gemini\antigravity-cli\settings.json`    |
| Antigravity CLI + 2.0 (shared) [^agycli] | `~/.gemini/config/mcp_config.json`                                | `%USERPROFILE%\.gemini\config\mcp_config.json`           |
| Antigravity 2.0                          | `~/.gemini/antigravity/mcp_config.json`                           | `%USERPROFILE%\.gemini\antigravity\mcp_config.json`      |

[^agycli]: **Antigravity CLI has two valid config paths.** Pick one of:

    - **CLI-only:** if you don't use Antigravity 2.0. Write the `mcpServers` block to `~/.gemini/antigravity-cli/settings.json` — that's the only config file `agy` reads in this mode. (You still complete Step 4 → Step 5 for the restart + `/mcp` verify; "CLI-only" refers to the path-decision, not the workflow.)
    - **Shared (with the symlink workaround in [Step 4 Form B Pro-tip](#form-b--absolute-paths-fallback)):** if you use both products and want one source of truth. **Only `agy` natively reads `~/.gemini/config/mcp_config.json`** — Antigravity 2.0 reads `~/.gemini/antigravity/mcp_config.json` and does NOT pick up the shared path automatically. Without the symlink, you'd be back to two separate files. **Don't pick "shared" without also applying the symlink** — the configs will drift the moment you edit either side.

    Gemini CLI and Antigravity CLI both also read project-scoped settings from `<project>/.gemini/settings.json` (cascades over the global file — useful for repo-specific overrides).


**If the file exists**, back it up with a date-time suffix:

| OS                   | Command (substitute your client's path)                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                | `cp "$HOME/.gemini/settings.json" "$HOME/.gemini/settings.json.bak.$(date +%Y%m%d-%H%M%S)"`                                             |
| Windows (PowerShell) | `Copy-Item "$env:USERPROFILE\.gemini\settings.json" "$env:USERPROFILE\.gemini\settings.json.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"` |

**If the file does not exist** (fresh machine): skip the backup, but ensure the parent directory exists before Step 4 (some editors won't auto-create it on save):

| OS                   | Command                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| macOS                | `mkdir -p "$HOME"/.gemini` (substitute your client's parent dir)             |
| Windows (PowerShell) | `New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini" \| Out-Null` |

Step 4 then creates the config file with your MCP block.

### Step 4 — Configure your MCP client

Two forms supported. **Try Form A first** — it's strictly simpler and works for most clients.

#### Form A — bin shim (recommended)

Works for any client that resolves bare commands via the user's shell PATH: **Gemini CLI, Claude Code (CLI), Cursor**, and usually **Antigravity CLI** (`agy`) — see the [Antigravity CLI fallback paragraph below](#antigravity-cli-agy-fallback) if `/mcp` shows `agy` disconnected.

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

<a id="antigravity-cli-agy-fallback"></a>**Antigravity CLI (`agy`) fallback:** `agy` is a native binary distributed via Google's curl/PowerShell installer (not Node-managed) and **may not always inherit the nvm-managed shell PATH** when spawning subprocesses — particularly when launched from contexts that don't load `~/.zshrc` / `~/.zprofile` (some terminal multiplexers, GUI launchers). If `/mcp` inside `agy` shows `hafla-evwa-idl-gateway` as disconnected after a Form A config, switch to [Form B](#form-b--absolute-paths-fallback) with absolute Path A (`node`) + Path B (`src/index.js`).

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
- **Antigravity CLI (`agy`) — sometimes**, when spawned from contexts that don't load `~/.zshrc` / `~/.zprofile` (some terminal multiplexers, GUI launchers). If Form A works for your `agy` invocation, stay there; switch to Form B only if Form A produces a disconnected `/mcp` listing.

**Derive your paths** (run on your machine; do NOT copy from an example):

| OS                   | Path A (node)                | Path B (bridge entrypoint)                                          | Path C (gcloud's bin directory)         |
| -------------------- | ---------------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| macOS                | `node -p "process.execPath"` | `echo "$(npm root -g)/@hafla/intelligence-mcp-bridge/src/index.js"` | `dirname $(which gcloud)`               |
| Windows (PowerShell) | `node -p "process.execPath"` | `echo "$(npm root -g)\@hafla\intelligence-mcp-bridge\src\index.js"` | `(Get-Command gcloud).Source \| Split-Path` |

`node -p "process.execPath"` returns the absolute path to the Node binary that is _currently_ executing — single value, deterministic, identical syntax across both OSes. Avoids the `which node` / `where.exe node` multi-line ambiguity when multiple Node installs exist.

**Path C — why this is needed.** The bridge spawns `gcloud` directly via `execFile` at startup (pre-flight) and roughly every 55 minutes (token refresh). For desktop apps launched via launchd (macOS) or service host (Windows), the inherited subprocess `PATH` is minimal (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS) and does NOT contain `gcloud`'s install directory. Without injecting an `env.PATH` covering Path C, the bridge starts successfully but fails at pre-flight with `gcloud CLI not found` and the MCP client reports server disconnected. Form A doesn't have this problem because shell-PATH-inheriting clients already see `gcloud`.

Typical Path C values (use the derivation command above to get the actual one on your machine):

- **macOS (Apple Silicon Homebrew):** `/opt/homebrew/bin`
- **macOS (Intel Homebrew):** `/usr/local/bin`
- **macOS (direct Cloud SDK install via curl/tarball):** typically `$HOME/google-cloud-sdk/bin`
- **Windows (winget install Google.CloudSDK):** typically `C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin`

**Confirm Path B exists** before pasting into JSON (catches half-installed state — e.g., bridge installed under a different Node version than the one currently active):

| OS                   | Command                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| macOS                | `if test -f "$(npm root -g)/@hafla/intelligence-mcp-bridge/src/index.js"; then echo OK; else echo "NOT FOUND"; fi` |
| Windows (PowerShell) | `Test-Path "$(npm root -g)\@hafla\intelligence-mcp-bridge\src\index.js"`                                           |

Expected: `OK` (macOS) or `True` (Windows). If `NOT FOUND` (macOS) / `False` (Windows), the bridge is not installed under your active Node — go back to [Step 1](#step-1--install-the-bridge) and reinstall the bridge.

**Confirm Path C resolves `gcloud`** (catches "gcloud isn't installed where I think it is" before the bridge fails at pre-flight):

| OS                   | Command                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| macOS                | `if test -x "$(dirname $(which gcloud))/gcloud"; then echo OK; else echo "NOT FOUND — install gcloud first"; fi`        |
| Windows (PowerShell) | `Test-Path "$((Get-Command gcloud).Source \| Split-Path)\gcloud.cmd"`                                                  |

Expected: `OK` (macOS) or `True` (Windows). If `NOT FOUND` / `False`, install gcloud per [PREREQUISITES.md](./PREREQUISITES.md) — Form B can't paper over a missing `gcloud` binary.

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
      "env": {
        "PATH": "<Path C>:<directory containing Path A>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      },
      "trust": true
    }
  }
}
```

**Get `<directory containing Path A>`** symmetrically with Path C — `dirname $(node -p "process.execPath")` on macOS, `(node -p "process.execPath") | Split-Path` on Windows (PowerShell). It's just Path A with the trailing filename stripped.

**Why `env.PATH`.** Desktop apps spawn the bridge with a minimal inherited environment. The `env.PATH` block injects a PATH the bridge can rely on independently of the host app's launch context. Path C (gcloud's bin directory) is the load-bearing entry — without it, pre-flight fails. Including Path A's directory is defensive for any future bridge code that shells out (token refresh already does, via gcloud). The trailing standard system paths (`/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`) cover other utilities the bridge or its dependencies may invoke.

**Order matters.** List Path C FIRST so `gcloud` resolves to the directory you just verified — not to a possibly-stale `/usr/local/bin/gcloud` symlink further down the list. If your Path C happens to equal one of the trailing standard entries (Intel Macs where Homebrew installs to `/usr/local/bin`), list it once at the front and drop the duplicate from the tail — duplicates are functionally harmless but ugly.

**Windows note:** the env.PATH separator on Windows is `;` not `:`, and entries use Windows-style paths. Example:

```json
"env": {
  "PATH": "C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin;C:\\Users\\YOU\\AppData\\Roaming\\nvm\\v24.15.0;C:\\Windows\\System32;C:\\Windows"
}
```

**💡 Pro-tip — symlink-sync for users running BOTH Antigravity CLI AND Antigravity 2.0.** Antigravity CLI reads from `~/.gemini/antigravity-cli/settings.json` (CLI-only) or the shared `~/.gemini/config/mcp_config.json`; Antigravity 2.0 reads from `~/.gemini/antigravity/mcp_config.json`. To avoid maintaining the 2.0 config and the shared CLI config as two separate files that can drift, symlink the 2.0 path to the shared path so a single edit propagates to both products.

**macOS / Linux** (bash / zsh):

```bash
cp "$HOME"/.gemini/antigravity/mcp_config.json "$HOME"/.gemini/antigravity/mcp_config.json.bak.$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
rm -f "$HOME"/.gemini/antigravity/mcp_config.json
ln -s "$HOME"/.gemini/config/mcp_config.json "$HOME"/.gemini/antigravity/mcp_config.json
```

**Windows** (PowerShell, run as a regular user — symlink creation requires either Developer Mode enabled OR an elevated PowerShell):

```powershell
$src = "$env:USERPROFILE\.gemini\config\mcp_config.json"
$dst = "$env:USERPROFILE\.gemini\antigravity\mcp_config.json"
if (Test-Path $dst) { Copy-Item $dst "$dst.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')" }
Remove-Item $dst -ErrorAction SilentlyContinue
New-Item -ItemType SymbolicLink -Path $dst -Target $src | Out-Null
```

If Developer Mode is disabled and you don't want to elevate the PowerShell session, use a **hard link** instead — same single-source-of-truth effect, no symlink privilege requirement:

```powershell
New-Item -ItemType HardLink -Path $dst -Target $src | Out-Null
```

> **Caveat — hard links don't span volumes.** NTFS hard links only work when source and destination live on the same drive (same volume serial). If your `%USERPROFILE%` is on `C:` and the `.gemini/` directory is on a different drive (custom user-profile relocation, D:-as-home setups, mounted network drive), the hard-link command fails with a non-obvious error. In that case: enable Developer Mode (Settings → Privacy & security → For developers) and use the symbolic-link command above instead — symbolic links DO span volumes.

After linking, one edit to `~/.gemini/config/mcp_config.json` (or `%USERPROFILE%\.gemini\config\mcp_config.json`) is read by both Antigravity CLI (natively) and Antigravity 2.0 (via the link). Skip this entirely if you only run one product; it's drift prevention for the multi-product setup.

**Legacy note — Windsurf path:** Some older Antigravity 2.0 installs also read from `~/.codeium/windsurf/mcp_config.json` (the legacy Windsurf platform that Antigravity 2.0 inherited). If your `~/.gemini/antigravity/mcp_config.json` link doesn't propagate as expected, check whether your 2.0 install is reading from the Windsurf path instead. Quick diagnostic — confirms which config files actually exist and have content:

```bash
# macOS / Linux — explicit per-file check so missing files surface
for f in "$HOME"/.gemini/antigravity/mcp_config.json "$HOME"/.codeium/windsurf/mcp_config.json; do
  if [ -f "$f" ]; then
    echo "EXISTS  $f  ($(wc -c < "$f") bytes)"
    grep -q hafla-evwa-idl-gateway "$f" && echo "        contains hafla entry" || echo "        no hafla entry"
  else
    echo "MISSING $f"
  fi
done
```

```powershell
# Windows (PowerShell) — explicit per-file check
foreach ($f in @("$env:USERPROFILE\.gemini\antigravity\mcp_config.json","$env:USERPROFILE\.codeium\windsurf\mcp_config.json")) {
  if (Test-Path $f) {
    $bytes = (Get-Item $f).Length
    $hasHafla = Select-String -Path $f -Pattern 'hafla-evwa-idl-gateway' -Quiet
    echo "EXISTS  $f  ($bytes bytes, hafla entry: $hasHafla)"
  } else {
    echo "MISSING $f"
  }
}
```

If only the Windsurf path has the hafla entry (size > 0 and `grep hafla-evwa-idl-gateway` matches), 2.0 is reading from there — repeat the same symlink/hard-link pattern targeting `~/.codeium/windsurf/mcp_config.json` (or `%USERPROFILE%\.codeium\windsurf\mcp_config.json` on Windows).

### Step 5 — Reload your MCP client + end-to-end verify

Restart the client. **CLI clients (Gemini CLI, Antigravity CLI):** the MCP config is read once at startup — a full `/quit` and relaunch is required; hot-reload does NOT pick up config changes. **Desktop apps:** close + reopen the window (Cmd-Q / Alt-F4 + relaunch).

**Then verify the MCP server is connected BEFORE running a tool.** How depends on your client. **Menu paths in GUI clients drift between vendor releases** — if a path below doesn't match your version, the fallback is always to edit the JSON config file directly (per [Step 3 table](#step-3--back-up-your-mcp-client-config-if-it-exists)) and check the client's log/console for an MCP-server-loaded entry.

| Client                                     | Connection-status check                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code / Gemini CLI / Antigravity CLI | Type `/mcp` at the prompt. `hafla-evwa-idl-gateway` should appear with status **Connected** (or equivalent wording).                                                                                                                                                |
| Cursor                                     | Open **Settings → MCP** (or the MCP panel in the sidebar). `hafla-evwa-idl-gateway` should appear with a green/connected indicator. If the menu has moved, the fallback is to confirm the entry in `~/.cursor/mcp.json` and check Cursor's developer console for MCP-server load logs. |
| Claude Desktop                             | Open **Settings → Developer** (or the MCP servers section in Settings). `hafla-evwa-idl-gateway` should appear in the configured servers list. Status indicators vary across Claude Desktop versions; fallback is to inspect the configured-servers list itself.   |
| Antigravity 2.0                            | From the Agent session view, click the **…** dropdown at the top of the side panel → **MCP Servers** → in the MCP Store, click **Manage MCP Servers** to see the configured-servers list (and **View raw config** to inspect the JSON). Alternative path: **User Settings → Customizations**. *(Verified against Antigravity 2.0 UI as of 2026-05-26 — vendor may rearrange between releases; fallback is to inspect `~/.gemini/antigravity/mcp_config.json` directly.)* |

If the server doesn't appear or shows as disconnected, the bridge didn't load — see [Troubleshooting](#troubleshooting). The connection check is cheap and gives a deterministic load/connect signal before you fire a real tool call.

> **Common recovery paths from a disconnected `/mcp` listing:**
> - **Antigravity CLI (`agy`)** specifically — see [Antigravity CLI fallback](#antigravity-cli-agy-fallback) in Step 4 (`agy` may not inherit nvm PATH; switch to Form B).
> - **Claude Desktop / Antigravity 2.0** — desktop apps don't inherit shell PATH; use Form B with absolute paths (see [Form B](#form-b--absolute-paths-fallback)).
> - **Any client** — re-run [Step 2 verify](#step-2--verify-install) to confirm the bin shim is on PATH; if Form B, re-derive Path A + Path B (the global node_modules root moves on nvm version changes).

> ⚠️ **`/mcp` is a slash command, not a universal verification path.** It only works in Claude Code, Gemini CLI, and Antigravity CLI. If you type `/mcp` into the **Cursor chat box** or **Claude Desktop chat box**, it gets submitted as raw text to the model (the model will probably say something like "I don't recognise that command" — and the bridge stays unverified). Use the Settings panel paths in the table above for those clients.

**Gemini CLI users — what to expect on first launch:** Gemini CLI may show two prompts the bridge cannot suppress:

1. **Folder Trust prompt** — Gemini CLI asks you to trust the current workspace folder. Click **Trust folder**. Without this, MCP servers (including this bridge) won't load.
2. **Second Google sign-in** — Gemini CLI's own OAuth scope is separate from the `gcloud auth login` you completed in PREREQUISITES. Sign in again with your `@hafla.com` Google account. The bridge still uses the gcloud-minted token for `mcp.hafla.com` calls; this second sign-in is purely Gemini-CLI-side and typically only needed once (Gemini CLI may re-prompt later if its own OAuth token expires or its scope changes).

Both prompts are expected Gemini CLI behaviors, not bridge errors.

**Antigravity CLI / Antigravity 2.0 users:** these products share the underlying Gemini agent harness, so similar first-launch prompts (Folder Trust, separate Google sign-in) may apply — the same guidance above holds. The bridge's behaviour is identical across all clients; what varies is the host product's own onboarding UX.

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

**🟢 401 / 403 from the gateway is a GOOD signal, not a setup failure.** It means the bridge loaded, the gcloud-minted token reached `mcp.hafla.com`, and the gateway is just gating your identity. Everything client-side worked; the fix is an Ops-side ticket (add you to the Workspace group / set `isEmployeeActive=true`). If you reach a 401/403, you can stop debugging your setup — the install is correct.

| Symptom                          | Literal stderr (grep target)                                    | Cause                                                | Fix                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Wrong Node version               | `requires Node 24 LTS (you are on v...)`                        | Node ≠ 24.x                                          | `nvm use 24.15.0`. If on Form B, also re-derive Path A (Node binary path may have moved).                                      |
| gcloud not found                 | `gcloud CLI not found`                                          | (1) gcloud not installed; OR (2) gcloud IS installed (works in your shell) but the MCP client spawned the bridge with a minimal PATH that doesn't include gcloud's bin directory — typical for desktop apps via launchd (macOS) / service host (Windows) | (1) If `gcloud --version` fails in your shell too: install per [PREREQUISITES.md](./PREREQUISITES.md) (Windows Step 4 / macOS Step 5). (2) If `gcloud --version` works in your shell but bridge says not found: you're on [Form B](#form-b--absolute-paths-fallback) and your config's `env.PATH` doesn't include Path C. Re-derive `Path C` via `dirname $(which gcloud)` (macOS) or `(Get-Command gcloud).Source \| Split-Path` (Windows) and add it to your `env.PATH`. |
| Wrong gcloud account             | `Active gcloud account is X — must be an @hafla.com account`    | Personal account active                              | `gcloud config set account YOU@hafla.com`; verify with `gcloud auth list`.                                                     |
| 401 audience mismatch            | `gateway returned 401 — token audience likely mismatched`       | Not in `team@hafla.com` Workspace group              | Ping Ops to be added. If you ARE in the group, run `gcloud auth login` to mint a fresh token.                                  |
| 403 employee inactive            | `gateway returned 403 employee_inactive`                        | `haflaCore.OpsUsers` row not active                  | Ping Ops to set `isEmployeeActive=true` on your row.                                                                           |
| Token mint failure               | `Failed to mint Google ID token`                                | Credentials expired or SDK stale                     | `gcloud auth login` to re-authenticate; `gcloud components update` to refresh the SDK.                                         |
| Silent disconnect                | (no bridge banner — client log shows "MCP server disconnected") | bin shim not on PATH (Form A) or wrong path (Form B) | Re-run Step 2 verify. If Form A bin shim doesn't resolve, switch to Form B. If Form B path is wrong, re-derive on the machine. |
| Windows: PowerShell script error | `running scripts is disabled on this system`                    | PowerShell ExecutionPolicy blocks `.ps1` shims       | Invoke the `.cmd` wrapper directly: `intelligence-mcp-bridge.cmd` (works regardless of `ExecutionPolicy`).                     |
| Antigravity 2.0 / Claude Desktop: bridge does not load even after Form A | (no bridge banner; client log shows "MCP server disconnected" or empty tool list) | Desktop app spawned via launchd (macOS) or service host (Windows) — does NOT inherit shell PATH, so bare `intelligence-mcp-bridge` can't be resolved | Switch to [Form B](#form-b--absolute-paths-fallback) with absolute Path A (`node`) + Path B (`src/index.js`). |
| Antigravity CLI: `agy` searches the filesystem instead of using gateway tools | (no error — agent silently falls back to file/bash tools to answer queries) | Bridge not loaded: config file missing, empty, or invalid JSON; OR `agy` was not fully restarted after the config edit (hot-reload doesn't apply) | Verify the config exists and parses (Node is already required for the bridge so this is universal): `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('OK')" "$HOME"/.gemini/antigravity-cli/settings.json` (substitute the shared path `"$HOME"/.gemini/config/mcp_config.json` if you use that one). Fully `/quit` and relaunch `agy`. Run `/mcp` inside `agy` to confirm `hafla-evwa-idl-gateway` shows as Connected. |

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

**Antigravity CLI users:** `agy` itself is a native binary installed outside the Node ecosystem (`~/.local/bin/agy` on macOS, `%LOCALAPPDATA%\Antigravity\agy.exe` on Windows). nvm version switches do NOT affect `agy` — only the bridge it spawns moves with Node. If `agy` works after a Node version change but the bridge doesn't, the issue is in the bridge install (reinstall under new Node), not in `agy`.

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
