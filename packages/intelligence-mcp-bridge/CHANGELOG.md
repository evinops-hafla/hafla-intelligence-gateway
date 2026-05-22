# Changelog

All notable changes to `@hafla/intelligence-mcp-bridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Windows: bridge no longer fails with `spawn EINVAL` when minting Google
  ID tokens via `gcloud.cmd`. Root cause: Node 24's CVE-2024-27980
  hardening rejects `.cmd`/`.bat` shims via `execFile` unless `shell: true`
  is passed. The fix is platform-conditional (`shell: true` on win32 only).
  Non-Windows code path is unchanged.

### Documentation

- PREREQUISITES.md (Windows): added top-of-section callout for PATH refresh
  after Node / gcloud install. Added explicit guidance to always open a new
  PowerShell window after `nvm use 24.15.0`.
- README.md (Step 5 — Reload your MCP client + end-to-end verify):
  added "What to expect on first launch" note — Gemini CLI's Folder
  Trust prompt + second Google sign-in are expected Gemini CLI
  behaviors, not bridge errors. Placed at Step 5 (where the prompts
  actually fire) rather than under Form A which is a shared spec
  across Gemini CLI / Claude Code CLI / Cursor.

### Security

- **Windows shell-injection mitigation in `--audiences=` flag.** The
  `shell: true` workaround for CVE-2024-27980 below makes `cmd.exe`
  interpret shell metacharacters in the concatenated command line
  before `gcloud` sees argv. `config.audience` (sourced from
  `GATEWAY_AUDIENCE` env) was previously read verbatim with no
  validation, allowing a malicious operator-set value containing `&`,
  `|`, `^`, `%`, etc. to execute arbitrary commands when the bridge
  minted a token. Added `validateAudience()` (exported) called at
  module load: enforces (1) parses as URL, (2) origin-only (no
  path/query/hash/userinfo), (3) zero shell metacharacters in the
  raw string. Bridge exits with a diagnostic banner if
  `GATEWAY_AUDIENCE` fails validation. Closes a privilege-elevation
  vector (write-to-config → arbitrary command execution as the user
  on every token mint).
- **Upgrade note — stricter `GATEWAY_AUDIENCE` validation.** Operators
  who explicitly set `GATEWAY_AUDIENCE` to a non-origin URL on 1.0.4
  (e.g., one with a path like `https://mcp.hafla.com/mcp`, a query
  string, a fragment, or shell metacharacters in the host) will see
  the bridge exit on startup with a diagnostic banner under 1.0.5.
  Fix: set `GATEWAY_AUDIENCE` to a plain origin URL
  (`https://mcp.hafla.com`). Default install (no `GATEWAY_AUDIENCE`
  set) is unaffected.

## [1.0.4] — 2026-05-21

**Note on context.** Operational completion of the 1.0.3 Node 24 LTS pin ship. Two defects flagged by `gemini-code-assist[bot]` on PR #3 after the 1.0.3 tag was already pushed and the publish workflow had already run — both fixed here. 1.0.3 is deprecated post-1.0.4; use 1.0.4 onward. The root README's `### @hafla/intelligence-mcp-bridge` teaser section's install config was also corrected (removed an interim broken `execFileSync(...HASH...)` snippet that would have shipped to GitHub-rendered README readers; replaced with a pointer to the canonical package-README install config).

### Fixed

- **`BRIDGE_SHUTDOWN_DRAIN_MS` NaN-coercion bug.** When this env var was
  set to a non-numeric string, `Number.parseInt` returned `NaN` and
  `setTimeout(fn, NaN)` coerced silently to `setTimeout(fn, 0)` — causing
  the bridge to exit immediately with no drain window. Extracted
  `parseDrainTimeoutMs` into `src/drain-timeout.js`; uses `Number.isFinite`
  to reject `NaN` and fall back to the 2 s default while still preserving
  an explicit `=0` (operator opts out of drain entirely). 6 new
  `node:test` unit tests cover NaN-rejection, 0-preservation, undefined,
  empty, valid numeric, and parseInt-prefix semantics. All 48 tests pass.

### Changed

- **README MCP client config corrected to the two-path form.** The
  prior README used a one-path form (`"command": "npx"` + args) that
  silently fails on macOS because GUI apps (Claude Desktop) inherit
  launchd's PATH, not the shell's — `npx` is never on launchd PATH even
  when nvm is set up correctly. The documented config now requires
  two explicit absolute paths: one for `node` (the `command` field) and
  one for the `npx` script (first element of `args`), both obtained via
  `which node` / `which npx` after `nvm use`. A fragility note explains
  path requirements per version manager (nvm / fnm / Volta / nvm-windows)
  and when to update (Node minor/patch upgrade, bridge version bump).

## [1.0.3] — 2026-05-20

**Note on versioning.** Strictly per semver, hard-pinning Node 24 LTS
from `>=20` is a major bump (would be `2.0.0`). This release ships as
`1.0.3` because there are no production consumers of this package
outside the Hafla Google Workspace org today; the install is gated at
`mcp.hafla.com`, not at the bridge. Republishing as `2.0.0` after
deleting `1.x` would be more disruption than the org will absorb. If
you are on Node 20 or 22 and your install fails, upgrade to Node 24
LTS — see README § "Prerequisites".

### Changed

- `engines.node` pinned to the Node 24 LTS track (`^24.15.0`)
- Added `.nvmrc` (`24.15.0`) and `.npmrc` (`engine-strict=true`)
- Added a Node-major-version guard in the bridge entrypoint that exits
  with a clear message on Node ≠ 24
- README rewritten to recommend a Node version manager
  (nvm / fnm / nvm-windows / asdf) — no specific manager is enforced,
  and `NVM_DIR` is NOT checked (would break Claude Desktop subprocess env)
- README install command pinned to
  `npx -y @hafla/intelligence-mcp-bridge@1.0.3` (declarative,
  audit-friendly, no registry round-trip per session)
- CI matrix collapsed to `['24.15.0']`
- **`BRIDGE_SHUTDOWN_DRAIN_MS` env var** — the 2s graceful-shutdown drain
  timeout is now operator-tunable via this environment variable
  (default: `2000`). Useful when the bridge runs under a process
  supervisor or alongside long-running `safe_sql_sandbox` queries
  (e.g., set `BRIDGE_SHUTDOWN_DRAIN_MS=10000` for a 10s window). Has no
  effect in the common single-user, on-demand invocation model.

## [1.0.2] — 2026-05-18

### Fixed

- **`extractSseJson` now respects SSE event boundaries — returns the LAST event's data, not a concatenation across events.** Caught by `gemini-code-assist[bot]` on PR #2 ([discussion r3256298335](https://github.com/evinops-hafla/hafla-intelligence-gateway/pull/2#discussion_r3256298335)). The 1.0.1 implementation iterated every `data:` line in the response body regardless of which SSE event it belonged to, joined them with `\n`, and `JSON.parse`d the result. The docstring already promised "last event," so this was a contract violation. For the current Hafla gateway flow it didn't fire (the gateway emits exactly one `event: message` per request-response), but any prefix `ping` / keepalive / progress event from a future MCP server SDK upgrade would break the parser silently. Fix: snapshot accumulated `data:` lines on each blank line into `lastDataLines`, reset `currentDataLines`; at end-of-body return whichever buffer is non-empty (handles bodies without a trailing blank line per SSE spec). Three regression tests added covering: (1) ping-then-message ordering, (2) unterminated final event, (3) comment + ping suffix not clobbering the prior message.

### Verification

- `node --test tests/index.test.js` → 40/40 pass on Node 25.9.0 (was 37/37; +3 multi-event SSE tests).

## [1.0.1] — 2026-05-18

### Added — defensive hygiene (post-PR-review, 2026-05-18 Gemini review)

- **`CLOUDSDK_CORE_DISABLE_PROMPTS=1` env var on all `gcloud` subprocess calls.** Forecloses any future gcloud version that might add interactive prompts to `print-identity-token` or `auth list` — a stdio-bridge subprocess can't service interactive prompts without hanging. `execFile` already isolates gcloud's stdout/stderr into buffers (no leakage to the bridge's MCP JSON-RPC stream); this is purely defensive. No current failure mode. (`src/index.js` `execGcloud`.)
- **`AbortController`-based shutdown drain** for in-flight `forwardRequest` HTTP calls. On `SIGTERM`/`SIGINT`, the bridge already waits up to 2s for in-flight responses to settle. If the drain times out, the bridge now `.abort()`s each in-flight `AbortController`, which calls `req.destroy()` on the underlying socket — so the remote (Cloud Run) sees an explicit TCP FIN/RST rather than waiting for keepalive timeout on a process-exited client. Brief 50ms delay between abort and `process.exit` so the OS can flush the FIN/RST packets. Best-practice hygiene for HTTP clients exiting with active requests; impact is minimal at single-user stdio-bridge scale but the right shape if the bridge ever runs in higher-throughput contexts (CI / Cloud Run / Vertex). New params: `forwardRequest({..., abortSignal})`, `handleMessage({..., abortSignal})`. Both are optional and back-compatible — callers that don't pass `abortSignal` see no behavioural change.

### Verification — defensive hygiene

- `node --test tests/index.test.js` → 37/37 pass (was 35/35; +2 abort-path tests).
- New tests cover: (a) abort fires `req.destroy()` + resolves with `-32000 Aborted on shutdown` error frame; (b) callers that don't pass `abortSignal` see unchanged behaviour (regression guard).

### Compatibility — defensive hygiene

- All new params are optional and additive. No breaking change at the public API or CLI surface.

---

### Fixed

- **BS-3 resolution.** 1.0.0 unconditionally passed `--audiences=$GATEWAY_AUDIENCE` to `gcloud auth print-identity-token` — a service-account-only flag. Running from a human `@hafla.com` account produced `Invalid account type for --audiences. Requires valid service account.` and the bridge could not mint a usable token for any human user. 1.0.1 implements **Shape B**: omit `--audiences` when the active gcloud account is human; keep it when the active account is a service account.
- **Head-of-line blocking on the stdio pipeline** (caught by software-design review). 1.0.0's `lineTransform` called `callback(null, response)` _inside_ `forwardRequest.then()`, which made Node's Transform stream serialise: stdin reads stopped until the in-flight HTTP request to the gateway returned. For a long-running tool call (e.g. `safe_sql_sandbox` with a 10s query), the MCP client could not send `notifications/cancelled` or any parallel request — they sat in the pipe buffer for the duration. This violated the MCP spec's concurrency + cancellation requirements. 1.0.1 calls `callback()` immediately after parsing the line, fires `forwardRequest` asynchronously, and pushes responses via `this.push(...)` as they arrive. Out-of-order responses are now possible and expected (JSON-RPC clients correlate by `id`); a `flush()` override drains in-flight responses before stream end so no late response is lost.
- **Token cache stampede on concurrent MCP startup requests** (caught by same review). 1.0.0's `createTokenCache.getToken()` had no in-flight tracking: N concurrent callers with an empty cache spawned N parallel `gcloud auth print-identity-token` subprocesses. MCP clients send 3-5 parallel requests on connection (initialize + tools/list + resources/list + ...), so the bridge regularly thundered gcloud. 1.0.1 stores the in-flight mint promise (`pendingMint`); concurrent callers within the same mint window await the same promise — gcloud spawns exactly once per refresh cycle. `pendingMint` clears in a `finally` so a failed mint doesn't strand subsequent retries.
- **Multi-byte UTF-8 corruption at pipe-buffer boundaries** (caught by same review). 1.0.0's `lineSplitter.transform` called `chunk.toString()` on a Buffer; if a multi-byte character (emoji, CJK script) was split across two pipe-buffer chunks, the partial buffer's `.toString()` corrupted the codepoint and produced `JSON.parse` errors downstream. 1.0.1 calls `process.stdin.setEncoding('utf8')` before the pipeline, engaging Node's internal `StringDecoder` which correctly buffers partial multi-byte sequences across reads.
- **Multi-byte UTF-8 corruption on the HTTP response body** (caught by dl-review 2026-05-17 MEDIUM #1, symmetric to the stdin fix above). 1.0.1's first draft missed the response-side equivalent: `forwardRequest`'s `res.on('data', ...)` handler did `body += chunk.toString()` on each chunk, with the same mid-codepoint corruption risk. The MCP gateway's `search_internal_knowledge` tool returns WhatsApp corpus content (Arabic, emoji, mixed-script); a TCP chunk split mid-codepoint corrupted the body and `JSON.parse(body)` returned `-32700 Parse error` to the client. Final 1.0.1 calls `res.setEncoding('utf8')` immediately upon receiving the response, before attaching the `data` handler. Regression-guarded by two new tests: (1) a functional test that splits a UTF-8-encoded Arabic + emoji JSON body mid-codepoint, simulates Node's `StringDecoder` via the mock, and asserts the content survives intact; (2) a behavioural test that asserts `setEncoding('utf8')` is called BEFORE the `data` handler is attached.

### Operator-visible changes (final pre-merge polish)

- **Missing-email diagnostic banner restructured.** When `gcloud` produces a token without an `email` claim (rare in practice), the banner now distinguishes two root causes: the common one (impersonation config — humans only) and the rare one (SA-native context where the SA's token format omits email). Each case gets its own copy-paste-runnable recovery steps. The earlier framing implied a single root cause and was misleading for the SA-native edge case. No behavioural change; only the error-message text.
- **SIGTERM / SIGINT now drain in-flight responses before exit.** Previously the bridge exited immediately on signal, dropping any in-flight `forwardRequest` responses. New behaviour: on signal, the bridge waits up to **2 seconds** for in-flight responses to land, then exits cleanly (exit 0 on drain success; exit 1 on drain timeout with a `droppedCount` log entry). A second signal during shutdown forces immediate exit. Acceptable for the typical stdio-MCP-disconnect case (parent process already going away) AND for future contexts running under a process supervisor that expects graceful shutdown. Operators will see new shutdown log lines (`Shutdown signal — draining in-flight responses`, `Drain complete — exiting`) where 1.0.0 logged only `SIGTERM received`.
- **Internal robustness (no operator-visible effect):** added a `.catch()` on the `handleMessage` promise in the line-transform pipeline as a defensive backstop against a destroyed-stream edge case; hoisted the `SA_EMAIL_SUFFIX` constant so both `preFlight` and `createTokenCache` reference the same definition instead of duplicating the literal.
- **Case-sensitive Workspace-domain check in preFlight** (caught by same review). 1.0.0's preFlight rejected `Sidd@HAFLA.com` (mixed case) as not matching the `@hafla.com` domain, even though the gateway's middleware case-normalises emails before the `OpsUsers` lookup. 1.0.1 lowercases both sides of the domain comparison in preFlight, mirroring the gateway's behaviour.

### Added

- **Post-mint identity cross-check (hard-reject).** After minting, the bridge decodes the JWT payload and compares the token's `email` claim against the active gcloud account. If they differ — almost always because `gcloud config set auth/impersonate_service_account` (or the equivalent env var / wrapper) is in effect — the bridge hard-rejects with a multi-step recovery checklist. This protects D-4's "verified email claim IS the user identity" property at the bridge layer; warning-and-passing would silently erase the operator's identity from the gateway audit trail.
- New exported `decodeJwtPayloadNoVerify(token)` — minimal base64-url JWT-payload decoder (no signature verification; the gateway re-verifies via jose against Google JWKS). Used by the cross-check.

### Verification

- Cross-check correctness validated against **gcloud SDK 568.0.0**: empirical test confirmed `gcloud auth list --filter=status:ACTIVE` returns the underlying human account even when `auth/impersonate_service_account` is configured (the impersonation is an API-level override applied on top of the active credential). **Re-verify on any gcloud SDK major-version bump** — if `gcloud auth list` ever starts reporting the impersonated SA as active, the cross-check needs a different detection mechanism.
- One half of the empirical proof remains pending: confirming that `gcloud auth print-identity-token` actually mints AS the SA under impersonation config (operator has no `tokenCreator` binding on any SA to test locally). The cross-check fires correctly either way: real impersonation → mismatch → reject; silent fallback to user-mint → match → pass. Worth verifying on the first machine where `tokenCreator` is granted.

### Compatibility

- Source-level changes to `createTokenCache`: new optional `activeAccount`, `failFn`, `decodeJwtFn` parameters. When `activeAccount` is null (the 1.0.0 call shape), behaviour is identical to 1.0.0 — `--audiences` is always passed, no cross-check runs. The new defaults activate only when `main()` wires the value through from `preFlight()`. **No breaking change for the npx-bin use case** that operators actually consume — happy-path (human on `@hafla.com` with no impersonation config, OR SA running natively in CI / Cloud Run) is unchanged.
- **Behavioural change for operators with persistent gcloud impersonation config.** 1.0.0 silently produced an unusable token (token's `email` claim = SA's email, NOT the human's) and either failed obscurely at the gateway's audience check or — pre-cutover — succeeded with the SA-attributed audit log. 1.0.1 hard-rejects at the bridge with an actionable banner identifying the impersonation-config root cause + 4-step recovery. This is intentional, NOT a regression — see § Added "Post-mint identity cross-check". Operators in this state run `gcloud config unset auth/impersonate_service_account` (and unset the env-var equivalent) once; thereafter the bridge works without further action.
- **Operator symptom under persistent impersonation config:** every MCP-client-spawned bridge dies at preFlight or first `getToken()`. The MCP client (Claude Code, Cursor, Gemini CLI) auto-respawns; the bridge dies again on the same config. From the operator's UI this surfaces as a repeating "MCP server disconnected" notice, NOT the bridge's stderr banner. **The actual fix is in the MCP client's debug log** — open it, find the bridge's stderr output, and follow the 4-step impersonation-unset recipe. Until the operator does this, the loop continues every spawn. (No way to break the loop from the bridge side without compromising the audit-attribution property — see Path A rationale in the `mcp-gateway` private repo's `specs/.../research/2026-05-16-bs3-final-plan-synthesis.md`.)

### Deploy ordering (operator-facing)

1.0.1 mints tokens **without** `--audiences` when the active gcloud account is human (Shape B). The Cloud Run gateway must therefore accept tokens with `aud=32555940559.apps.googleusercontent.com` (gcloud SDK's default OAuth client ID) — this is the **Path A multi-audience** change in the gateway's `auth.js` + the multi-value `--add-custom-audiences` on the Cloud Run service. **Deploy the gateway-side Path A change BEFORE updating any client's `.mcp.json` to 1.0.1** — otherwise the gateway will 401 on every request from the new bridge until the gateway accepts the broader audience.

### Cross-references

- Canonical resolution plan: <https://github.com/evinops-hafla/hafla-intelligence/blob/feat/mcp-gateway-hardening/mcp-gateway/specs/history-and-future/history/research/2026-05-16-bs3-final-plan-synthesis.md> (private repo, consolidated onto `feat/mcp-gateway-hardening` 2026-05-16)
- Gateway-side changes (multi-audience + `hd` guard): private repo branch `feat/mcp-gateway-hardening` (PR #200)

### Deferred to 1.1.0

- **Module split.** Software Architecture review (2026-05-16) flagged `src/index.js` at ~794 lines as a monolith mixing config, auth, RPC, and lifecycle concerns. The split into `src/config.js`, `src/log.js`, `src/jwt.js`, `src/gcloud.js`, `src/token-cache.js`, `src/rpc.js`, `src/index.js` is deferred from the 1.0.1 review cycle to a dedicated 1.1.0 release. Reason: 1.0.1's 4 design-review fixes (HOL blocking, stampede, UTF-8, case-sensitive domain) are functional improvements; the split is a structural refactor with no behavioural change. Bundling them into one release would extend the review cycle for no functional benefit and mix concerns in the operator's review surface. The header comment in `src/index.js` carries the `TODO(1.1.0)` block with the suggested split boundaries.

## [1.0.0] — 2026-05-16

### Added

- Initial public release. Extracted from the private monorepo's `hafla-intelligence/mcp-gateway/scripts/mcp-gateway-bridge.js`.
- stdio↔HTTPS bridge with 60-minute Google ID token minting via `gcloud auth print-identity-token`, in-memory cache with 5-min refresh-ahead window, and 401-triggered cache invalidation.
- Pre-flight checks: gcloud installed, an `@hafla.com` account is the active one.
- Runtime diagnostic banners for the four most common failure modes (gcloud not found, wrong-domain account, 401 audience mismatch, 403 employee_inactive).
- Cross-platform support — Windows is handled by a `GCLOUD_BIN` constant that picks `gcloud.cmd` over `gcloud` based on `process.platform`.
- Zero npm runtime dependencies — Node ≥20 stdlib only.
