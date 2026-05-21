# Prerequisites for `@hafla/intelligence-mcp-bridge`

One-time machine setup. Gets you to the state where the bridge install instructions in [README.md](./README.md) can run.

**Supported platforms:** Windows + macOS. Each section below is self-contained — follow only the one matching your operating system.

> **Note** — This document captures the recommended setup as of the time of writing. Tooling evolves: Node versions advance, version managers change, MCP client install paths get tweaked, and individual machines arrive in non-standard states. The verify commands in [§ Desired target state](#desired-target-state) are the contract; a machine satisfies prerequisites if those commands succeed, **regardless of the path taken to install**. The per-OS steps below are the recommended path — IT admins can substitute alternate tooling (corporate MSI installers, asdf, mise, official Node installer, etc.) if a machine arrives in a messy state and the canonical flow fights it.

---

## Desired target state

These checks define "prerequisites met." If all pass on the machine, skip to [README.md](./README.md) — you're done here.

| Check                                                      | Command                                    | Expected output                                            |
| ---------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Node 24 LTS is the active Node                             | `node -v`                                  | `v24.15.0` or newer `v24.x.y`                              |
| npm is recent                                              | `npm -v`                                   | `10.x` or newer                                            |
| Version manager present (Windows)                          | `nvm version`                              | A version string (e.g. `1.1.12`)                           |
| Version manager present (macOS)                            | `command -v nvm`                           | `nvm` (a shell function)                                   |
| MCP client is installed against Node 24 (CLI clients only) | `gemini --version` or `claude --version`   | Version string with **no `EBADENGINE` warning in stderr**  |
| gcloud SDK installed                                       | `gcloud --version`                         | Prints SDK version                                         |
| `@hafla.com` account active in gcloud                      | `gcloud auth list`                         | An ACTIVE row matching your `@hafla.com` email             |

If any check fails, follow the per-OS playbook below to reach this state. If the per-OS playbook doesn't fit the machine (corporate lockdown, pre-existing tooling, etc.), the goal is still these checks — get the machine there however you can.

---

## Install order

1. **Version manager** — `nvm-windows` on Windows; `nvm` (via Homebrew) on macOS
2. **Node 24 LTS** via the version manager, set as the active Node
3. **Your MCP client** (Gemini CLI or Claude Code) — installed UNDER Node 24
4. **gcloud SDK**
5. **Sign in to gcloud with your `@hafla.com` account**

**Steps 1–3 must be in this order.** Reversing creates subtle breakage that manifests as "MCP server disconnected" with no useful error: each `npm install -g <client>` writes to the global registry of whichever Node was active at install time. If you install the MCP client first and switch to Node 24 later, the client appears to "disappear" because Node 24's global registry is empty.

**Steps 4–5 are independent of 1–3.** gcloud has no relationship with the Node ecosystem; install it before or after, in any session. All steps in your OS-specific section below must be complete before the bridge can authenticate.

GUI clients (Cursor, Claude Desktop) are not Node-managed — install them separately when convenient. They still depend on Node 24 at the bridge level (via Steps 1 and 2 below).

---

## Windows (PowerShell)

### 1. Install nvm-windows (Administrator required)

One-time. The nvm-windows installer is the only step on Windows that needs elevation — every subsequent command runs as the regular user.

1. Download `nvm-setup.exe` from the [nvm-windows releases page](https://github.com/coreybutler/nvm-windows/releases).
2. Right-click → **Run as administrator**. Accept the installer defaults.
3. **Close and reopen PowerShell** so `PATH` picks up the new `nvm` command. Alternatively - Refresh `PATH` in the current PowerShell session so the new `nvm` command is recognized immediately (no terminal restart needed):

   ```powershell
   $env:PATH = [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH","User")
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

**If `nvm use` fails with "access denied" or junction/symlink errors:** rerun the `nvm use` command in an Administrator PowerShell. This is rare on default Windows but can happen on locked-down corporate machines where Group Policy blocks junction creation for non-admin users.

Verify:

```powershell
node -v
npm -v
```

Expected: `v24.15.0` and `10.x` or newer.

### 3. Install your MCP client (Windows)

No elevation needed — `npm install -g` writes into the nvm-managed user prefix, not into `Program Files`.

Pick one. Most Hafla users: Gemini CLI.

```powershell
npm install -g @google/gemini-cli
# or:
npm install -g @anthropic-ai/claude-code
```

For Cursor or Claude Desktop, install via the vendor's GUI installer — these are not Node-managed and Node version does not affect their install.

Verify (CLI clients only):

```powershell
gemini --version
```

Expected: a version string with **no `EBADENGINE` warning** in stderr.

**If `EBADENGINE` appears**, the client was installed against a Node version other than 24. Recover by uninstalling and reinstalling under Node 24:

```powershell
npm uninstall -g @google/gemini-cli
npm install -g @google/gemini-cli
```

**If you see "running scripts is disabled on this system"** instead of a version string: your PowerShell ExecutionPolicy is blocking the `.ps1` shim. Invoke the `.cmd` wrapper directly to sidesteps the `.ps1` resolution path:

```powershell
gemini.cmd --version
```

### 4. Install gcloud SDK (Windows)

```powershell
winget install Google.CloudSDK
```

**UAC will prompt during install** — the Google Cloud SDK ships as an MSI that requires elevation to register system-wide. Click **Yes** when prompted. You do NOT need to start PowerShell as Administrator for this — UAC handles the elevation for just the MSI step.

Refresh `PATH` in the current PowerShell session so `gcloud` is recognized immediately:

```powershell
$env:PATH = [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH","User")
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
mkdir -p ~/.nvm
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
echo "[ -s \"$(brew --prefix nvm)/nvm.sh\" ] && . \"$(brew --prefix nvm)/nvm.sh\"" >> ~/.zshrc
echo "[ -s \"$(brew --prefix nvm)/etc/bash_completion.d/nvm\" ] && . \"$(brew --prefix nvm)/etc/bash_completion.d/nvm\"" >> ~/.zshrc
source ~/.zshrc
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

Expected: `v24.15.0` and `10.x` or newer.

### 4. Install your MCP client (macOS)

Pick one. Most Hafla users: Gemini CLI.

**Do not prefix with `sudo`.** nvm-managed Node uses a user-writable global prefix; `sudo npm install -g` writes to the wrong location and creates permission issues that surface later as "command not found" or `EACCES` errors.

```bash
npm install -g @google/gemini-cli
# or:
npm install -g @anthropic-ai/claude-code
```

For Cursor or Claude Desktop, install via the vendor's GUI installer — these are not Node-managed and Node version does not affect their install.

Verify (CLI clients only):

```bash
gemini --version
```

Expected: a version string with **no `EBADENGINE` warning** in stderr.

**If `EBADENGINE` appears**, the client was installed against a Node version other than 24. Recover by uninstalling and reinstalling under Node 24:

```bash
npm uninstall -g @google/gemini-cli
npm install -g @google/gemini-cli
```

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

Proceed to [README.md § Prerequisites](./README.md#prerequisites) to install and configure the bridge itself.
