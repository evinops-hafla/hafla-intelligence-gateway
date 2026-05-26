# Prerequisites for `@hafla/intelligence-mcp-bridge`

One-time machine setup. Gets you to the state where the bridge install instructions in [README.md](./README.md) can run.

**Supported platforms:** Windows + macOS. Each section below is self-contained — follow only the one matching your operating system.

> **Note** — This document captures the recommended setup as of the time of writing. Tooling evolves: Node versions advance, version managers change, MCP client install paths get tweaked, and individual machines arrive in non-standard states. The verify commands in [§ Desired target state](#desired-target-state) are the contract; a machine satisfies prerequisites if those commands succeed, **regardless of the path taken to install**. The per-OS steps below are the recommended path — IT admins can substitute alternate tooling (corporate MSI installers, asdf, mise, official Node installer, etc.) if a machine arrives in a messy state and the canonical flow fights it.

---

## Desired target state

These checks define "prerequisites met." If all pass on the machine, skip to [README.md](./README.md) — you're done here.

| Check                                                                 | Command                                  | Expected output                                                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Node 24 LTS is the active Node                                        | `node -v`                                | `v24.15.0` or newer `v24.x.y`                                                                                                    |
| npm is recent                                                         | `npm -v`                                 | `11.x` or newer                                                                                                                  |
| Version manager present (Windows)                                     | `nvm version`                            | A version string (e.g. `1.1.12`)                                                                                                 |
| Version manager present (macOS)                                       | `command -v nvm`                         | `nvm` (a shell function)                                                                                                         |
| Node-managed MCP client installed against Node 24 (Gemini CLI / Claude Code) | `gemini --version` or `claude --version` | Version string with **no `EBADENGINE` warning in stderr**                                                                  |
| Antigravity CLI (if using)                                            | `agy --version`                          | Version string. `agy` is not Node-managed; no `EBADENGINE` possible.                                                             |
| gcloud SDK installed                                                  | `gcloud --version`                       | Prints SDK version                                                                                                               |
| `@hafla.com` account active in gcloud                                 | `gcloud auth list`                       | An ACTIVE row matching your `@hafla.com` email                                                                                   |

If any check fails, follow the per-OS playbook below to reach this state. If the per-OS playbook doesn't fit the machine (corporate lockdown, pre-existing tooling, etc.), the goal is still these checks — get the machine there however you can.

---

## Install order

1. **Version manager** — `nvm-windows` on Windows; `nvm` (via Homebrew) on macOS
2. **Node 24 LTS** via the version manager, set as the active Node
3. **Your MCP client** — pick one (or several):
   - **Option A — Node-managed (Gemini CLI or Claude Code):** `npm install -g` UNDER Node 24. Must run AFTER Steps 1+2.
   - **Option B — Antigravity CLI (`agy`):** Google curl/PowerShell installer. **NOT Node-managed** — install order independent of Steps 1-2.
   - **Option C — desktop apps (Claude Desktop / Cursor / Antigravity 2.0):** vendor installer. **NOT Node-managed** — install order independent.
4. **gcloud SDK**
5. **Sign in to gcloud with your `@hafla.com` account**

**Steps 1–3 (Option A only) must be in this order.** Reversing creates subtle breakage that manifests as "MCP server disconnected" with no useful error: each `npm install -g <client>` writes to the global registry of whichever Node was active at install time. If you install a Node-managed MCP client first and switch to Node 24 later, the client appears to "disappear" because Node 24's global registry is empty.

**Antigravity CLI and Antigravity 2.0 are independent of this order.** They are native binaries installed outside the Node ecosystem and can be installed before or after Steps 1–3.

**Steps 4–5 are independent of 1–3.** gcloud has no relationship with the Node ecosystem; install it before or after, in any session. All steps in your OS-specific section below must be complete before the bridge can authenticate.

---

## Antigravity CLI + Antigravity 2.0 — coexistence notes

### Antigravity CLI + Antigravity 2.0 (clean coexistence)

`agy` and Antigravity 2.0 share the same underlying agent harness and run side-by-side with no conflicts.

- **Shared settings:** tool permissions and preferences adjusted in one apply to the other automatically.
- **Separate data dirs:** `~/.gemini/antigravity-cli/` (CLI) vs `~/.gemini/antigravity/` (2.0 app).
- **MCP config:** each client reads from a different file — see [README.md § Step 3](./README.md#step-3--back-up-your-mcp-client-config-if-it-exists) config-path table. The optional `~/.gemini/config/mcp_config.json` is a shared file that both products read; use it if you want one source of truth for `mcpServers`.

### Antigravity 2.0 + Antigravity IDE ⚠️ installer conflict (both macOS AND Windows)

Antigravity 2.0 and the older Antigravity IDE have conflicting system-level installers — confirmed across both operating systems per multiple Google AI Developers Forum threads.

- **The conflict:** installing Antigravity 2.0 can hijack the Antigravity IDE binary; the IDE refuses to launch or crashes on startup. Affects macOS AND Windows.
- **Uninstalling 2.0 does not automatically heal the IDE.** Recovery requires backing up `~/.gemini/antigravity-ide/` and reinstalling the IDE from a version that predates the 2.0 split (e.g. 1.23.2).

**If you only need Antigravity 2.0:** uninstall the IDE first; then install 2.0 cleanly.

**If you need both on the same machine (not recommended):**

1. Back up `~/.gemini/antigravity-ide/` (or `%USERPROFILE%\.gemini\antigravity-ide\` on Windows) before installing or updating anything.
2. Install Antigravity 2.0 and the CLI first and let the modern ecosystem settle its paths.

---

## Windows (PowerShell)

> **⚠️ Windows tip — open a fresh PowerShell after each install step.** When you install nvm-windows, switch Node versions with `nvm use`, or install the gcloud SDK, the new commands may not be recognized in your current PowerShell session — and you'll see `command not found` errors. The reliable fix every time: **close PowerShell and open it fresh.** Each step below also offers an in-session `PATH` refresh as an alternative, but opening a new window is the simplest path and always works.

### 1. Install nvm-windows (Administrator required)

One-time. The nvm-windows installer is the only step on Windows that explicitly requires you to **Run as administrator**. You may still see UAC prompts during later steps — the gcloud SDK install (Step 4) ships as an MSI that triggers UAC, and on locked-down corporate Windows machines `nvm use` (Step 2) can fail with an access-denied error that needs admin. Both are handled inline at their respective steps. Every other command runs as the regular user.

1. Download `nvm-setup.exe` from the [nvm-windows releases page](https://github.com/coreybutler/nvm-windows/releases).
2. Right-click → **Run as administrator**. Accept the installer defaults.
3. **Close and reopen PowerShell** so `PATH` picks up the new `nvm` command. Alternatively - Refresh `PATH` in the current PowerShell session so the new `nvm` command is recognized immediately (no terminal restart needed). The form below appends the freshly-read registry PATH onto your current session PATH, so any session-only additions (venv activations, tool temp exports) are preserved:

   ```powershell
   $env:PATH = [Environment]::ExpandEnvironmentVariables(
  [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
  [Environment]::GetEnvironmentVariable("PATH","User") + ";" + $env:PATH)
   ```

Verify:

```powershell
nvm version
```

Expected: a version string (e.g. `1.1.12`).

### 2. Install Node 24 LTS via nvm-windows

Usually no elevation needed. nvm-windows installs Node into a user-writable location under `%APPDATA%\nvm\` and uses NTFS junctions (not symlinks) to switch active versions.

```powershell
nvm install 24.15.0
nvm use 24.15.0
```

**After `nvm use 24.15.0`, always open a new PowerShell window before verifying.** In-session `PATH` refresh isn't reliable for nvm-managed Node version switches — a fresh PowerShell is the simplest, always-works fix.

**If `nvm use` fails with "access denied" or junction/symlink errors:** rerun the `nvm use` command in an Administrator PowerShell. This is rare on default Windows but can happen on locked-down corporate machines where Group Policy blocks junction creation for non-admin users.

Verify:

```powershell
node -v
npm -v
```

Expected: `v24.15.0` and `11.x` or newer.

### 3. Install your MCP client (Windows)

Pick one option (or combine — they coexist). Most Hafla users use Gemini CLI or Antigravity CLI.

#### Option A — Node-managed (Gemini CLI or Claude Code)

No elevation needed — `npm install -g` writes into the nvm-managed user prefix, not into `Program Files`.

```powershell
npm install -g @google/gemini-cli
# or:
npm install -g @anthropic-ai/claude-code
```

Verify:

```powershell
gemini --version
```

Expected: a version string with **no `EBADENGINE` warning** in stderr.

**If `EBADENGINE` appears**, the client was installed against a Node version other than 24. Recover by uninstalling and reinstalling under Node 24:

```powershell
npm uninstall -g @google/gemini-cli
npm install -g @google/gemini-cli
```

**If you see "running scripts is disabled on this system"** instead of a version string: your PowerShell ExecutionPolicy is blocking the `.ps1` shim. Invoke the `.cmd` wrapper directly to sidestep the `.ps1` resolution path:

```powershell
gemini.cmd --version
```

#### Option B — Antigravity CLI (`agy`) — NOT Node-managed

`agy` is a native binary distributed via a Google-hosted PowerShell installer script. It installs to `%LOCALAPPDATA%\Antigravity\` and has no dependency on Node or nvm — Node version changes do not affect it.

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

**Close and reopen PowerShell** so PATH picks up the new `agy` command. Verify:

```powershell
agy --version
```

Expected: a version string (e.g. `1.0.2`). No `EBADENGINE` warning is possible — `agy` is not a Node package.

#### Option C — Desktop apps (Cursor, Claude Desktop, Antigravity 2.0) — NOT Node-managed

Install via the vendor's installer:

- **Cursor:** download from [cursor.com](https://cursor.com/download) (Windows installer).
- **Claude Desktop:** download from [claude.ai/download](https://claude.ai/download) (Windows installer).
- **Antigravity 2.0:** download from [antigravity.google](https://antigravity.google/product/antigravity-2) (Windows installer). ⚠️ **If you have the older Antigravity IDE installed:** uninstall it before installing Antigravity 2.0. See [§ Coexistence notes](#antigravity-cli--antigravity-20--coexistence-notes) above.

These are not Node-managed and Node version does not affect their install. Verify by launching the app from the Start menu.

### 4. Install gcloud SDK (Windows)

```powershell
winget install Google.CloudSDK
```

**UAC will prompt during install** — the Google Cloud SDK ships as an MSI that requires elevation to register system-wide. Click **Yes** when prompted. You do NOT need to start PowerShell as Administrator for this — UAC handles the elevation for just the MSI step.

**Close and reopen PowerShell** so `PATH` picks up the new `gcloud` command. Alternatively - Refresh `PATH` in the current PowerShell session so `gcloud` is recognized immediately (no terminal restart needed). The form below appends the freshly-read registry PATH onto your current session PATH, so any session-only additions (venv activations, tool temp exports) are preserved:

```powershell
$env:PATH = [Environment]::ExpandEnvironmentVariables(
  [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
  [Environment]::GetEnvironmentVariable("PATH","User") + ";" + $env:PATH)
```

Verify:

```powershell
gcloud --version
```

Expected: prints SDK version info (Google Cloud SDK, bq, core, gsutil).

### 5. Sign in to gcloud with your `@hafla.com` account (Windows)

```powershell
gcloud auth login
```

A browser window opens — sign in with your `@hafla.com` account. If you have other gcloud accounts on this machine, also set the active account explicitly:

```powershell
gcloud config set account YOU@hafla.com
```

> **Multi-profile users (developers with separate GCP projects / client accounts):** the simple `gcloud config set account` mutates the **default** configuration in-place. If you have local scripts or other tooling expecting the default config to point at a different account, switching it here will break those workflows on your next session. Use a named configuration instead:
>
> ```powershell
> gcloud config configurations create hafla
> gcloud config configurations activate hafla
> gcloud config set account YOU@hafla.com
> gcloud auth login
> # Activate this profile per-session whenever you work on Hafla:
> #   gcloud config configurations activate hafla
> ```
>
> Skip this whole sub-tip if Hafla is your only GCP account — the simple `set account` form above is correct for that case.

Verify:

```powershell
gcloud auth list
```

Expected: an `ACTIVE` row (`*` marker) on the line for your `@hafla.com` email.

**Hafla onboarding note.** After this completes, the bridge still needs two Ops-set conditions on your account before the gateway accepts your requests:

- Membership in the `team@hafla.com` Google Workspace group.
- `isEmployeeActive=true` on your `haflaCore.OpsUsers` row.

The Techy Helper / Power User can't set these — Ops does. If you haven't received onboarding confirmation, the bridge will start and the MCP client will connect, but the gateway will return `403 employee_inactive` on the first request. Ping Ops to unblock.

---

## macOS (Terminal)

### 1. Install Homebrew (if not present)

Check first:

```bash
which brew
```

If it prints a path (e.g. `/opt/homebrew/bin/brew` on Apple Silicon, or `/usr/local/bin/brew` on Intel), skip to Step 2.

Otherwise, install Homebrew. The installer prompts for `sudo` once.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**Apple Silicon only:** the installer does NOT auto-add `brew` to your shell PATH; you have to do it explicitly (the installer prints these commands in its "Next steps" output too). Run:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME"/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

The first line persists across future shell sessions; the second line activates `brew` in the current session.

On **Intel Macs**, the installer places `brew` at `/usr/local/bin/brew` which is already on the default PATH — no shell-profile edit needed.

Verify:

```bash
which brew
```

Expected: a path under `/opt/homebrew/` (Apple Silicon) or `/usr/local/` (Intel).

### 2. Install nvm via Homebrew

No sudo needed.

```bash
brew install nvm
```

Then add nvm to your shell profile. The block below uses `$(brew --prefix nvm)` so the correct path is resolved automatically on both Apple Silicon and Intel Macs:

```bash
mkdir -p "$HOME"/.nvm
echo 'export NVM_DIR="$HOME/.nvm"' >> "$HOME"/.zshrc
echo "[ -s \"$(brew --prefix nvm)/nvm.sh\" ] && . \"$(brew --prefix nvm)/nvm.sh\"" >> "$HOME"/.zshrc
echo "[ -s \"$(brew --prefix nvm)/etc/bash_completion.d/nvm\" ] && . \"$(brew --prefix nvm)/etc/bash_completion.d/nvm\"" >> "$HOME"/.zshrc
source "$HOME"/.zshrc
```

(The `$(brew --prefix nvm)` is expanded by your shell at the time you run these `echo` commands, so the literal path gets baked into `~/.zshrc`. No runtime overhead on future shell starts.)

Verify:

```bash
command -v nvm
```

Expected: `nvm` (a shell function — not a file path).

### 3. Install Node 24 LTS via nvm

```bash
nvm install 24.15.0
nvm use 24.15.0
nvm alias default 24.15.0
```

Verify:

```bash
node -v
npm -v
```

Expected: `v24.15.0` and `11.x` or newer.

### 4. Install your MCP client (macOS)

Pick one option (or combine — they coexist). Most Hafla users use Gemini CLI or Antigravity CLI.

#### Option A — Node-managed (Gemini CLI or Claude Code)

**Do not prefix with `sudo`.** nvm-managed Node uses a user-writable global prefix; `sudo npm install -g` writes to the wrong location and creates permission issues that surface later as "command not found" or `EACCES` errors.

```bash
npm install -g @google/gemini-cli
# or:
npm install -g @anthropic-ai/claude-code
```

Verify:

```bash
gemini --version
```

Expected: a version string with **no `EBADENGINE` warning** in stderr.

**If `EBADENGINE` appears**, the client was installed against a Node version other than 24. Recover by uninstalling and reinstalling under Node 24:

```bash
npm uninstall -g @google/gemini-cli
npm install -g @google/gemini-cli
```

**If `npm install -g` fails with `EACCES` (Permission denied)** — your global npm prefix is set to a non-user-writable location, typically a stale `prefix=/usr/local` entry in `~/.npmrc` left over from a previous root-owned Node install (official Node macOS installer, system Node, etc.). Do NOT use `sudo`. Clear the stale prefix and let nvm re-apply its user-writable default:

```bash
npm config delete prefix
nvm use 24.15.0
npm install -g @google/gemini-cli
```

#### Option B — Antigravity CLI (`agy`) — NOT Node-managed

`agy` is a native binary distributed via a Google-hosted install script. It installs to `~/.local/bin/` and has no dependency on Node or nvm — Node version changes do not affect it and you do not need to reinstall it after switching Node versions.

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

The installer automatically appends `export PATH="$HOME/.local/bin:$PATH"` to both `~/.zshrc` and `~/.zprofile`. The PATH change is NOT active in your current terminal session — reload it:

```bash
source "$HOME"/.zshrc
```

Or open a new terminal tab. Then verify:

```bash
agy --version
```

Expected: a version string (e.g. `1.0.2`). No `EBADENGINE` warning is possible — `agy` is not a Node package.

#### Option C — Desktop apps (Cursor, Claude Desktop, Antigravity 2.0) — NOT Node-managed

Install via the vendor's installer:

- **Cursor:** download from [cursor.com](https://cursor.com/download) (macOS installer).
- **Claude Desktop:** download from [claude.ai/download](https://claude.ai/download) (macOS installer).
- **Antigravity 2.0:** download from [antigravity.google](https://antigravity.google/product/antigravity-2) (macOS installer; check the App Store if you prefer that channel). ⚠️ **If you have the older Antigravity IDE installed:** uninstall it before installing Antigravity 2.0. See [§ Coexistence notes](#antigravity-cli--antigravity-20--coexistence-notes) above.

These are not Node-managed and Node version does not affect their install. Verify by launching the app from your Applications folder.

### 5. Install gcloud SDK (macOS)

```bash
brew install --cask google-cloud-sdk
```

Verify:

```bash
gcloud --version
```

Expected: prints SDK version info (Google Cloud SDK, bq, core, gsutil).

### 6. Sign in to gcloud with your `@hafla.com` account (macOS)

```bash
gcloud auth login
```

A browser window opens — sign in with your `@hafla.com` account. If you have other gcloud accounts on this machine, also set the active account explicitly:

```bash
gcloud config set account YOU@hafla.com
```

> **Multi-profile users (developers with separate GCP projects / client accounts):** the simple `gcloud config set account` mutates the **default** configuration in-place. If you have local scripts or other tooling expecting the default config to point at a different account, switching it here will break those workflows on your next session. Use a named configuration instead:
>
> ```bash
> gcloud config configurations create hafla
> gcloud config configurations activate hafla
> gcloud config set account YOU@hafla.com
> gcloud auth login
> # Activate this profile per-session whenever you work on Hafla:
> #   gcloud config configurations activate hafla
> ```
>
> Skip this whole sub-tip if Hafla is your only GCP account — the simple `set account` form above is correct for that case.

Verify:

```bash
gcloud auth list
```

Expected: an `ACTIVE` row (`*` marker) on the line for your `@hafla.com` email.

**Hafla onboarding note.** After this completes, the bridge still needs two Ops-set conditions on your account before the gateway accepts your requests:

- Membership in the `team@hafla.com` Google Workspace group.
- `isEmployeeActive=true` on your `haflaCore.OpsUsers` row.

The Techy Helper / Power User can't set these — Ops does. If you haven't received onboarding confirmation, the bridge will start and the MCP client will connect, but the gateway will return `403 employee_inactive` on the first request. Ping Ops to unblock.

---

## Done

Proceed to [README.md § Prerequisites verify](./README.md#prerequisites-verify) to install and configure the bridge itself.
