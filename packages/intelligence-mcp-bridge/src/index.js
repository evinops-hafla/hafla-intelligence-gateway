#!/usr/bin/env node
/**
 * MCP stdio bridge for the Hafla Intelligence Gateway at mcp.hafla.com.
 *
 * stdio↔HTTPS forwarder with Google ID token minting + caching + diagnostics,
 * used by Claude Code / Claude Desktop / Cursor / Gemini CLI to reach the
 * Cloud Run IAM-gated production service.
 *
 * Why this exists:
 *   MCP HTTP clients take only static headers in their config. Cloud Run IAM
 *   requires a fresh 60-min Google ID token. The bridge runs as a long-lived
 *   stdio child process, mints + caches the token via gcloud, refreshes ~55 min
 *   before expiry, and forwards JSON-RPC over HTTPS with a fresh Bearer
 *   header on every request.
 *
 * Pre-flight diagnostics (run once at startup):
 *   (a) gcloud CLI installed + at least one ACTIVE account
 *   (b) active account is on the required Workspace domain (default: hafla.com)
 * Runtime diagnostics (on 401 / 403 from gateway):
 *   (c) 401 = likely audience mismatch — points to --add-custom-audiences
 *   (d) 403 employee_inactive = OpsUsers.isEmployeeActive=false — contact ops
 *
 * Environment:
 * - GATEWAY_URL: gateway base URL (default https://mcp.hafla.com)
 * - GATEWAY_PATH: MCP endpoint path (default /mcp)
 * - GATEWAY_AUDIENCE: JWT aud claim (default GATEWAY_URL)
 * - REQUIRED_DOMAIN: required Workspace domain for active gcloud account (default hafla.com)
 * - REQUEST_TIMEOUT_MS: HTTP request timeout in ms (default 30000)
 * - TOKEN_REFRESH_BEFORE_MS: refresh-ahead window in ms (default 300000 = 5 min)
 * - DEBUG: set to "1" for verbose logging
 *
 * The script exits non-zero with an actionable diagnostic banner on any
 * pre-flight failure or on a hard runtime error. The diagnostic banner
 * is printed to stderr (stdout is reserved for MCP JSON-RPC traffic).
 *
 * TODO(1.1.0) — Module split (Software Architecture review, 2026-05-16).
 *
 * File is currently ~794 lines in a single module. Acceptable for 1.0.1
 * (single-binary npm package; zero deps; supply-chain audit story benefits
 * from one file). Deferred from 1.0.1 review cycle as Option C: ship the
 * 4 design-review fixes here, do the module split as a separate 1.1.0
 * release with its own review surface.
 *
 * Suggested split (section headers below align with the boundaries):
 *   - src/config.js       — config parsing + HTTPS enforcement (lines 48-97)
 *   - src/log.js          — log, diagnosticBanner, fail (lines 99-134)
 *   - src/jwt.js          — decodeJwtPayloadNoVerify (lines 136-156)
 *   - src/gcloud.js       — execGcloud, preFlight (lines 158-247)
 *   - src/token-cache.js  — createTokenCache (lines 249-472)
 *   - src/rpc.js          — forwardRequest, handleMessage (lines 474-770)
 *   - src/index.js        — main() + entry guard (lines 773-794)
 *
 * Constraints when doing the split:
 *   - Preserve all 26 tests; bridge behaviour must stay byte-equivalent
 *   - `npm pack --dry-run` must still produce a single tarball
 *   - Keep zero npm runtime dependencies (Node stdlib only)
 *   - Each module gets the same header-comment convention as this file
 */

import { request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const execFileAsync = promisify(execFile);

// Windows ships gcloud as gcloud.cmd; Node's execFile doesn't apply PATHEXT.
const GCLOUD_BIN = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';

// ── Configuration ────────────────────────────────────────────────────────────

const rawGatewayUrl = process.env.GATEWAY_URL || 'https://mcp.hafla.com';

// HTTPS enforcement — the bridge mints Google ID tokens; sending them over
// plaintext HTTP would expose them on the wire. Allow http:// only for local
// dev hostnames (localhost, 127.0.0.1) where there's no network exposure.
{
  const u = (() => {
    try {
      return new URL(rawGatewayUrl);
    } catch {
      process.stderr.write(
        `\n┌── intelligence-mcp-bridge: invalid GATEWAY_URL\n│ Could not parse: ${rawGatewayUrl}\n└──\n\n`
      );
      process.exit(1);
    }
  })();
  const isLocalDev =
    u.hostname === 'localhost' ||
    u.hostname === '127.0.0.1' ||
    u.hostname === '0.0.0.0';
  if (u.protocol !== 'https:' && !isLocalDev) {
    process.stderr.write(
      `\n┌── intelligence-mcp-bridge: refusing plaintext HTTP for non-local GATEWAY_URL\n│ Got: ${rawGatewayUrl}\n│ Fix: set GATEWAY_URL to https:// (or localhost for dev)\n└──\n\n`
    );
    process.exit(1);
  }
}

const config = {
  gatewayUrl: rawGatewayUrl,
  gatewayPath: process.env.GATEWAY_PATH || '/mcp',
  audience:
    process.env.GATEWAY_AUDIENCE ||
    process.env.GATEWAY_URL ||
    'https://mcp.hafla.com',
  requiredDomain: process.env.REQUIRED_DOMAIN || 'hafla.com',
  requestTimeoutMs: Number.parseInt(
    process.env.REQUEST_TIMEOUT_MS || '30000',
    10
  ),
  tokenRefreshBeforeMs: Number.parseInt(
    process.env.TOKEN_REFRESH_BEFORE_MS || '300000', // 5 min
    10
  ),
  // Google ID tokens have a fixed 60-min lifetime.
  tokenLifetimeMs: 60 * 60_000,
  debug: process.env.DEBUG === '1'
};

// ── Logging (stderr only — stdout is the MCP channel) ───────────────────────

const log = {
  info: (msg, data) =>
    process.stderr.write(
      JSON.stringify({ level: 'info', msg, ...data }) + '\n'
    ),
  warn: (msg, data) =>
    process.stderr.write(
      JSON.stringify({ level: 'warn', msg, ...data }) + '\n'
    ),
  error: (msg, data) =>
    process.stderr.write(
      JSON.stringify({ level: 'error', msg, ...data }) + '\n'
    ),
  debug: (msg, data) => {
    if (config.debug) {
      process.stderr.write(
        JSON.stringify({ level: 'debug', msg, ...data }) + '\n'
      );
    }
  }
};

// ── Diagnostic banner — actionable failure messages to stderr ───────────────

export function diagnosticBanner(title, ...lines) {
  process.stderr.write(`\n┌── intelligence-mcp-bridge: ${title}\n`);
  for (const l of lines) process.stderr.write(`│ ${l}\n`);
  process.stderr.write(`└──\n\n`);
}

function fail(title, ...lines) {
  diagnosticBanner(title, ...lines);
  process.exit(1);
}

/**
 * Service-account email suffix per Google IAM. Used in two places:
 *   - `preFlight` to allow SA-native bridge contexts (CI / Cloud Run / Vertex)
 *   - `createTokenCache` to branch Shape B (omit `--audiences` for humans)
 *
 * Hoisted here so both call sites use the same constant instead of duplicating
 * the literal. (Closes gemini-code-assist's PR #1 inline suggestion.)
 */
const SA_EMAIL_SUFFIX = '.iam.gserviceaccount.com';

// ── JWT payload decoder (no signature verification) ─────────────────────────

/**
 * Decode the payload (middle segment) of a JWT without verifying the
 * signature. Used by the post-mint identity cross-check below to read the
 * `email` claim from a token gcloud has just produced.
 *
 * We do NOT verify — the gateway re-verifies via jose against Google JWKS
 * (defence-in-depth). The bridge only needs to inspect the claim cheaply.
 *
 * Exported for test injection and for any future caller that needs the
 * same primitive.
 */
export function decodeJwtPayloadNoVerify(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('not a JWT (expected 3 dot-separated segments)');
  }
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(json);
}

// ── SSE response parsing ────────────────────────────────────────────────────

/**
 * Extract a single JSON payload from an MCP Streamable-HTTP SSE response body.
 *
 * Format (per W3C Server-Sent Events + MCP spec):
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *   <blank line>
 *
 * The MCP server may emit multiple events; for request-response calls there is
 * typically exactly one `message` event carrying the JSON-RPC reply. We
 * concatenate all `data:` lines from the last event (per SSE spec a multi-line
 * data field is joined by '\n') and JSON.parse the result.
 *
 * Exported for unit tests.
 */
export function extractSseJson(body) {
  const dataLines = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      // Strip the "data:" prefix and one optional leading space (SSE quirk:
      // "data: foo" and "data:foo" are both legal; the leading space is
      // stripped per the spec)
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) {
    throw new Error('SSE body contained no data: lines');
  }
  return JSON.parse(dataLines.join('\n'));
}

// ── gcloud invocation — injectable for tests ────────────────────────────────

/**
 * Execute a gcloud command. Returns trimmed stdout.
 * Throws {message, stderr, code} on failure.
 *
 * Exported for unit-test injection; tests replace it with a stub.
 */
export async function execGcloud(args, { execFn = execFileAsync } = {}) {
  try {
    // Defensive hygiene: CLOUDSDK_CORE_DISABLE_PROMPTS=1 guarantees gcloud
    // never tries to read from stdin or emit interactive prompts. With the
    // bridge spawned as a stdio subprocess by MCP clients, an interactive
    // prompt would hang the bridge indefinitely. `execFile` already isolates
    // gcloud's stdout/stderr into buffers (no leakage to the parent's MCP
    // JSON-RPC stream), but disabling prompts forecloses any future gcloud
    // version that might add interactive surface to `print-identity-token`
    // or `auth list`. Reviewer 2026-05-18 (defensive; no current failure).
    const { stdout } = await execFn(GCLOUD_BIN, args, {
      timeout: 15_000,
      env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' }
    });
    return stdout.toString().trim();
  } catch (err) {
    const stderr = err.stderr?.toString?.() ?? '';
    const wrapped = new Error(err.message);
    wrapped.stderr = stderr;
    wrapped.code = err.code;
    throw wrapped;
  }
}

// ── Pre-flight diagnostics ───────────────────────────────────────────────────

/**
 * Verify gcloud is installed, an account is active, and that account
 * is on the required Workspace domain. Exits non-zero with a banner on
 * any failure. Returns the active account email on success.
 */
export async function preFlight({ execGcloudFn = execGcloud } = {}) {
  // (a) gcloud installed + an active account exists
  let activeAccount;
  try {
    activeAccount = await execGcloudFn([
      'auth',
      'list',
      '--filter=status:ACTIVE',
      '--format=value(account)'
    ]);
  } catch (err) {
    if (err.code === 'ENOENT' || /not found|not installed/i.test(err.stderr)) {
      fail(
        'gcloud CLI not found.',
        'Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install',
        'Then run: gcloud auth login'
      );
    }
    fail(`gcloud auth check failed: ${err.message}`, 'Try: gcloud auth login');
  }

  if (!activeAccount) {
    fail(
      'No active gcloud account.',
      'Run: gcloud auth login',
      `Then ensure your @${config.requiredDomain} account is the active one.`
    );
  }

  // (b) active account must be either on the required Workspace domain
  // (human path — most operators) OR a service account (CI runner, Cloud
  // Run service, Vertex agent running natively under SA identity). SA
  // emails end in `.iam.gserviceaccount.com` and don't have an @domain
  // form; rejecting them here would block the legitimate SA-native flow
  // that createTokenCache's Shape B branch is designed to serve.
  //
  // Case normalisation: gcloud auth list MAY return emails with mixed case
  // (e.g. Sidd@HAFLA.com). The gateway's middleware case-normalises emails
  // for OpsUsers lookup (auth.js line 257); the bridge mirrors that to
  // avoid 403-ing valid accounts on case alone.
  const activeAccountLower = activeAccount.toLowerCase();
  const requiredDomainLower = config.requiredDomain.toLowerCase();
  const isSAActive = activeAccountLower.endsWith(SA_EMAIL_SUFFIX);
  const isOnRequiredDomain = activeAccountLower.endsWith(
    `@${requiredDomainLower}`
  );
  if (!isSAActive && !isOnRequiredDomain) {
    fail(
      `Active gcloud account is "${activeAccount}" — must be an @${config.requiredDomain} account OR a service account (.iam.gserviceaccount.com).`,
      `Run: gcloud config set account <your-${config.requiredDomain}-email>`,
      `(If you have not yet logged in with your ${config.requiredDomain} account:`,
      `   gcloud auth login)`
    );
  }

  log.info('Pre-flight OK', {
    account: activeAccount,
    audience: config.audience,
    domain: config.requiredDomain
  });
  return activeAccount;
}

// ── Token cache + minting ────────────────────────────────────────────────────

/**
 * Internal token cache state. Exposed via a factory so tests can reset
 * between cases.
 */
export function createTokenCache({
  execGcloudFn = execGcloud,
  audience = config.audience,
  lifetimeMs = config.tokenLifetimeMs,
  refreshBeforeMs = config.tokenRefreshBeforeMs,
  now = () => Date.now(),
  // Shape B + cross-check inputs. When `activeAccount` is null (legacy /
  // unit-test path), the cache behaves as 1.0.0 did: --audiences always
  // appended; no post-mint identity check. When provided (production via
  // main() → preFlight()), Shape B branches on the active-account type and
  // the cross-check rejects mismatches.
  activeAccount = null,
  // Test injection — `fail` calls process.exit(1) in production. Tests pass
  // a throwing stub so the cross-check rejection paths can be asserted.
  failFn = fail,
  decodeJwtFn = decodeJwtPayloadNoVerify
} = {}) {
  let cachedToken = null;
  let mintedAt = 0;
  // Concurrent-mint coalescing: when N callers hit getToken() with an
  // empty/stale cache simultaneously (the realistic case at MCP-client
  // startup, where tools/list + resources/list + initialize land
  // back-to-back), N parallel `gcloud auth print-identity-token`
  // subprocess spawns is wasteful + may trigger gcloud-side state locks
  // or rate limits. The first caller stores the in-flight promise here;
  // subsequent callers within the same window return the same promise
  // and await its resolution. Cleared in a `finally` so a failed mint
  // doesn't strand subsequent retries.
  let pendingMint = null;

  // Shape B: humans omit --audiences (gcloud --audiences is service-account-
  // only — BS-3). SAs (or unknown legacy/test contexts) keep --audiences for
  // backwards compatibility and for the SA path that actually requires it.
  const isHumanActive =
    typeof activeAccount === 'string' &&
    !activeAccount.toLowerCase().endsWith(SA_EMAIL_SUFFIX);

  async function mintAndCacheToken(t) {
    const args = ['auth', 'print-identity-token'];
    if (!isHumanActive) {
      args.push(`--audiences=${audience}`);
    }

    let token;
    try {
      token = await execGcloudFn(args);
    } catch (err) {
      log.error('Failed to mint identity token', {
        error: err.message,
        stderr: err.stderr
      });
      // This catch path also captures the empirically-unverified edge case
      // documented in `specs/.../research/2026-05-16-bs3-final-plan-synthesis.md`
      // § Empirical verification: human-active + impersonation-config-set +
      // no-`--audiences` (Shape B's human branch). If gcloud's IAM
      // Credentials API rejects the mint because it requires an audience
      // under impersonation, the error surfaces here as a "Failed to mint"
      // banner with the same PERMISSION_DENIED / impersonation hint.
      failFn(
        `Failed to mint Google ID token: ${err.message}`,
        'Common causes:',
        `  1. Expired credentials — run: gcloud auth login`,
        `  2. Wrong active project — check: gcloud config get-value project`,
        `  3. PERMISSION_DENIED on impersonation — the SA you're configured to`,
        `     impersonate may not grant you roles/iam.serviceAccountTokenCreator,`,
        `     OR you have not been added to the relevant role binding yet.`,
        `  4. gcloud's IAM Credentials API rejected the mint because the active`,
        `     account is human but impersonation config requires an audience.`,
        `     Unset impersonation: gcloud config unset auth/impersonate_service_account`
      );
      // failFn → process.exit(1) in production (synchronous; this return is
      // unreachable). Tests inject a non-throwing collector (collectingFailFn)
      // — the `return` is what halts execution under test so we don't fall
      // through to caching a token that was never minted.
      return undefined;
    }

    // Post-mint identity cross-check (Path A / BS-3 resolution).
    //
    // Only runs when activeAccount was provided (production flow via
    // preFlight). Skipped in legacy / unit-test contexts where the cache
    // is exercised in isolation.
    //
    // Why hard-reject rather than warn-then-pass:
    //   The bridge's local invariant is "the minted token represents the
    //   active gcloud account". If gcloud is configured to impersonate
    //   (config set auth/impersonate_service_account, env var, wrapper,
    //   future surface), the minted token's email claim will differ from
    //   the active account. Forwarding it would let the gateway's SA
    //   branch admit the request and erase the human's identity from the
    //   audit trail — silently violating D-4's "verified email claim IS
    //   the user identity" property at the bridge layer. Stderr warnings
    //   are too easy to suppress (MCP clients route stdio child stderr
    //   to debug logs or /dev/null). Hard-reject is the only sound
    //   posture.
    //
    // Why decode-not-parse: enumerating gcloud's impersonation surfaces
    // (config, env vars, wrappers, future flags) is a losing game. The
    // minted token's `email` claim is the deterministic source of truth
    // for what gcloud actually produced.
    if (activeAccount) {
      let claims;
      try {
        claims = decodeJwtFn(token);
      } catch (err) {
        failFn(
          `gcloud minted a token that does not parse as a JWT: ${err.message}`,
          'This usually means gcloud returned an unexpected output format.',
          'Try: gcloud components update'
        );
        return undefined;
      }

      if (typeof claims.email !== 'string') {
        failFn(
          'gcloud minted a token with no `email` claim.',
          '',
          'Most common cause — impersonation config (humans only):',
          '  gcloud is configured to impersonate a service account (via',
          '  "gcloud config set auth/impersonate_service_account", the',
          '  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT env var, a wrapper',
          '  script, or similar). The IAM Credentials API mints impersonation',
          '  tokens without the email claim by default. The bridge owns the',
          '  gcloud invocation — you cannot add a flag to fix this; the',
          '  impersonation config itself is the root cause.',
          '',
          '  To fix:',
          '    1. gcloud config unset auth/impersonate_service_account',
          '    2. unset CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT  (if set)',
          '    3. Check for any wrapper script or alias around "gcloud"',
          '    4. Restart the bridge.',
          '',
          'Rarer cause — SA-native context (CI / Cloud Run / Vertex):',
          '  Some service-account configurations produce ID tokens without',
          '  an email claim. The bridge cannot enforce per-user attribution',
          '  in that case and must reject. Verify by running (copy-paste,',
          '  no substitutions required — substitute your custom audience',
          '  only if GATEWAY_AUDIENCE is set to something other than the',
          '  default):',
          '    gcloud auth print-identity-token \\',
          '      --audiences=https://mcp.hafla.com \\',
          '      | cut -d. -f2 | base64 -d 2>/dev/null \\',
          '      | grep -o \'"email"[^,]*\'',
          '  If empty: this SA cannot produce an email claim; coordinate',
          '  with ops to either grant the SA the right config, or run the',
          '  bridge under a different SA whose tokens include email.'
        );
        return undefined;
      }

      if (claims.email.toLowerCase() !== activeAccount.toLowerCase()) {
        failFn(
          `Identity mismatch: gcloud minted a token for "${claims.email}"`,
          `but your active gcloud account is "${activeAccount}".`,
          '',
          'This almost always means gcloud is configured to impersonate a',
          'service account (via "gcloud config set',
          'auth/impersonate_service_account", the',
          'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT env var, a wrapper',
          'script, or similar). Forwarding this token would silently erase',
          'your identity from the gateway audit trail — Hafla MCP requires',
          'per-user attribution.',
          '',
          'To fix:',
          '  1. gcloud config unset auth/impersonate_service_account',
          '  2. unset CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT  (if set)',
          '  3. Check for any wrapper script or alias around "gcloud"',
          '  4. Restart the bridge.',
          '',
          'If you legitimately need to act as the service account, run',
          'the bridge from a CI / Cloud Run / Vertex context where the',
          'SA IS your active account — "gcloud auth list" should show',
          'the SA as active. The cross-check passes in that case.'
        );
        return undefined;
      }
    }

    cachedToken = token;
    mintedAt = t;
    log.info('Identity token minted', {
      ttlMs: lifetimeMs,
      nextRefreshInMs: lifetimeMs - refreshBeforeMs,
      identityCrossCheck: activeAccount ? 'verified' : 'skipped'
    });
    return cachedToken;
  }

  return {
    /**
     * Returns a fresh token, minting + caching as needed.
     *
     * Concurrent-mint coalescing: if N callers hit getToken() simultaneously
     * with empty/stale cache, only ONE gcloud subprocess spawns — the others
     * await the same in-flight promise. MCP clients commonly send 3-5
     * parallel requests on connection (initialize + tools/list + resources/list
     * etc.); without coalescing this would stampede gcloud with N parallel
     * subprocess spawns.
     */
    async getToken() {
      const t = now();
      if (cachedToken && t - mintedAt < lifetimeMs - refreshBeforeMs) {
        return cachedToken;
      }
      if (pendingMint) {
        return pendingMint;
      }
      pendingMint = mintAndCacheToken(t).finally(() => {
        pendingMint = null;
      });
      return pendingMint;
    },

    /** Force-invalidate the cache (used after a 401 from the gateway). */
    invalidate() {
      cachedToken = null;
      mintedAt = 0;
      // Intentionally NOT clearing pendingMint: if a mint is in flight when
      // a 401 comes back on a previously-cached token, the in-flight mint's
      // result is fresh and valid (the 401 was about the OLD token). Let
      // it complete; coalesced callers benefit from the fresh token.
    },

    /** Test/diagnostic accessor. */
    _state() {
      return { cached: !!cachedToken, mintedAt, pendingMint: !!pendingMint };
    }
  };
}

// ── HTTP forwarder ───────────────────────────────────────────────────────────

/**
 * Forward a single JSON-RPC message to the gateway. Returns the parsed
 * JSON-RPC response object. Handles 401/403 with diagnostic banners.
 *
 * Exported with injectable cache + httpRequest for testing.
 */
export async function forwardRequest(
  message,
  {
    tokenCache,
    httpRequestFn = httpsRequest,
    gatewayUrl = config.gatewayUrl,
    gatewayPath = config.gatewayPath,
    requestTimeoutMs = config.requestTimeoutMs,
    // Optional AbortSignal. If aborted (e.g., during shutdown-drain timeout),
    // the underlying `req` is destroyed and the promise resolves with a
    // JSON-RPC abort-error frame. Without this, `process.exit()` would tear
    // down sockets at the OS level without an explicit TCP FIN/RST initiation
    // from Node, leaving the remote (Cloud Run) to clean up on its own
    // keepalive timeout. Best-practice hygiene; impact is minimal at single-
    // user stdio-bridge scale but cleaner if the bridge ever runs in
    // higher-throughput contexts. Reviewer 2026-05-18.
    abortSignal
  }
) {
  if (!message || typeof message !== 'object') {
    return {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request' },
      id: message?.id ?? null
    };
  }

  const token = await tokenCache.getToken();
  const messageStr = JSON.stringify(message);
  const url = new URL(gatewayPath, gatewayUrl);

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      req.destroy();
      log.warn('Request timeout', {
        method: message.method,
        id: message.id,
        timeoutMs: requestTimeoutMs
      });
      resolve({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Request timeout after ${requestTimeoutMs}ms`
        },
        id: message.id ?? null
      });
    }, requestTimeoutMs);

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(messageStr),
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'User-Agent': 'intelligence-mcp-bridge/1.0'
      }
    };

    const req = httpRequestFn(options, (res) => {
      // Engage Node's internal StringDecoder so partial multi-byte UTF-8
      // sequences across TCP chunk boundaries are buffered safely. Without
      // this, a 4-byte emoji or 2-3 byte Arabic codepoint split across two
      // chunks would corrupt when `chunk.toString()` ran on the partial
      // buffer, and JSON.parse(body) downstream would either throw or
      // produce wrong content. Symmetric with the stdin-side fix at the
      // bottom of this file (`process.stdin.setEncoding('utf8')`). The
      // customer-facing WhatsApp corpus and AlloyDB queries against
      // user-entered content routinely include multi-byte payloads — this
      // is not a theoretical concern.
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => {
        body += chunk; // chunk is now a string; no .toString() needed
      });
      res.on('end', () => {
        clearTimeout(timeoutId);

        // 401 — likely audience mismatch (Cloud Run rejected the token).
        if (res.statusCode === 401) {
          diagnosticBanner(
            'gateway returned 401 — token audience likely mismatched',
            `The gateway expects tokens whose "aud" claim matches a configured custom-audience.`,
            `Confirm both required audiences are present:`,
            `  gcloud run services describe mcp-gateway-production --region=us-central1 \\`,
            `    --format='value(spec.customAudiences)'`,
            `Both must be in the output (Path A multi-audience):`,
            `  - https://mcp.hafla.com           (service URL — SA path)`,
            `  - 32555940559.apps.googleusercontent.com  (gcloud SDK default — human path)`,
            `If either is missing, the operator redeploys via the canonical script:`,
            `  bash infra/mcp-gateway/scripts/cloud-service-deploy.sh`,
            `Bridge will invalidate cached token and retry on the next request.`
          );
          tokenCache.invalidate();
        }

        // 403 employee_inactive — OpsUsers.isEmployeeActive=false.
        if (res.statusCode === 403 && /employee_inactive/.test(body)) {
          diagnosticBanner(
            'gateway returned 403 employee_inactive',
            `Your account is not flagged as an active Hafla employee in OpsUsers.`,
            `Contact ops to verify your isEmployeeActive flag in haflaCore.OpsUsers.`
          );
        }

        if (res.statusCode !== 200) {
          log.warn('Gateway non-200', {
            statusCode: res.statusCode,
            id: message.id,
            bodyPreview: body.slice(0, 200)
          });
          resolve({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: `Gateway returned ${res.statusCode}`
            },
            id: message.id ?? null
          });
          return;
        }

        // The MCP Streamable HTTP transport may respond with either
        // `application/json` (single JSON-RPC frame) or `text/event-stream`
        // (SSE). The gateway picks based on internal heuristics; both are
        // protocol-valid (MCP spec 2024-11-05 § "Streamable HTTP"). Detect
        // by Content-Type and parse accordingly. Without this, every tool
        // call returns -32700 to the client when the gateway picks SSE.
        const contentType = (res.headers?.['content-type'] || '').toLowerCase();
        const isSse = contentType.includes('text/event-stream');
        let payload;
        try {
          payload = isSse ? extractSseJson(body) : JSON.parse(body);
        } catch (e) {
          log.error('Failed to parse gateway response', {
            parseError: e.message,
            contentType,
            id: message.id,
            bodyLength: body.length
          });
          resolve({
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' },
            id: message.id ?? null
          });
          return;
        }
        resolve(payload);
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeoutId);
      log.error('Gateway request failed', {
        error: err.message,
        code: err.code,
        id: message.id,
        host: url.hostname
      });
      resolve({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Connection failed: ${err.code || err.message}`
        },
        id: message.id ?? null
      });
    });

    // Wire optional abort signal — destroys the underlying socket so the
    // remote sees an explicit TCP FIN/RST rather than waiting for keepalive
    // timeout on a process-exited client. Idempotent: if abortSignal is
    // already aborted at this point (rare; shutdown happened between
    // forwardRequest entry and req creation), destroy immediately.
    if (abortSignal) {
      if (abortSignal.aborted) {
        req.destroy(new Error('aborted before send'));
      } else {
        abortSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeoutId);
            req.destroy(new Error('aborted on shutdown drain'));
            resolve({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Aborted on shutdown' },
              id: message.id ?? null
            });
          },
          { once: true }
        );
      }
    }

    req.write(messageStr);
    req.end();
  });
}

// ── Main pipeline (line-based stdio) ─────────────────────────────────────────

/**
 * Handle a single MCP message: parse, forward to gateway, emit response.
 *
 * Extracted from main() for testability + so the line-transform's `transform`
 * can be a thin wrapper. Returns a Promise that resolves when the response
 * (or parse-error) has been pushed; tests track concurrency by awaiting
 * multiple in parallel.
 *
 * Concurrency contract: caller MAY invoke this for multiple lines without
 * awaiting each one — that's the whole point of the fix for HIGH #1
 * (head-of-line blocking). Out-of-order responses are allowed by JSON-RPC
 * (clients correlate by `id`).
 *
 * Exported for unit testing.
 */
export async function handleMessage(
  rawLine,
  {
    tokenCache,
    pushFn,
    forwardRequestFn = forwardRequest,
    logFn = log,
    abortSignal
  } = {}
) {
  const line = typeof rawLine === 'string' ? rawLine : rawLine.toString();
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (parseErr) {
    logFn.error('Failed to parse stdin line', {
      error: parseErr.message,
      line: line.slice(0, 100)
    });
    pushFn(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null
      }) + '\n'
    );
    return;
  }

  try {
    const response = await forwardRequestFn(message, {
      tokenCache,
      abortSignal
    });
    pushFn(JSON.stringify(response) + '\n');
  } catch (err) {
    logFn.error('Unexpected forwardRequest error', { error: err.message });
    pushFn(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: message.id ?? null
      }) + '\n'
    );
  }
}

async function main() {
  const activeAccount = await preFlight();
  // Pass activeAccount into the cache → enables Shape B (omit --audiences
  // for human active accounts) AND the post-mint identity cross-check
  // (hard-reject if gcloud silently minted as a different identity, e.g.
  // global impersonation config).
  const tokenCache = createTokenCache({ activeAccount });

  log.info('intelligence-mcp-bridge started', {
    gatewayUrl: config.gatewayUrl,
    gatewayPath: config.gatewayPath,
    audience: config.audience,
    requestTimeoutMs: config.requestTimeoutMs
  });

  // Fix HIGH #3 (multi-byte UTF-8 corruption): engage Node's internal
  // StringDecoder so partial multi-byte sequences across pipe-buffer
  // boundaries are buffered safely. Without this, `chunk.toString()`
  // on a buffer that ends mid-codepoint corrupts the character →
  // JSON.parse throws downstream → false parse-error response.
  process.stdin.setEncoding('utf8');

  const lineSplitter = new Transform({
    encoding: 'utf8',
    decodeStrings: false,
    transform(chunk, encoding, callback) {
      const str = (this.lastLine || '') + chunk;
      this.lastLine = '';
      const lines = str.split('\n');
      this.lastLine = lines.pop();
      for (const line of lines) {
        if (line.trim()) this.push(line + '\n');
      }
      callback();
    },
    flush(callback) {
      if (this.lastLine?.trim()) {
        this.push(this.lastLine + '\n');
      }
      callback();
    }
  });

  // In-flight response tracking for graceful shutdown. Without this, a
  // pending forwardRequest could be racing with process.exit when stdin
  // closes, dropping its response on the floor.
  const inFlight = new Set();

  // AbortControllers per in-flight request. On shutdown-drain timeout we
  // iterate this Set and call .abort() on each so the underlying `req` is
  // destroyed and the remote sees an explicit FIN/RST rather than waiting
  // for keepalive timeout. At single-user stdio-bridge scale this is
  // hygiene rather than urgent (Cloud Run handles abandoned sockets within
  // seconds), but it's the documented best practice for HTTP clients
  // exiting with active requests. Reviewer 2026-05-18.
  const abortControllers = new Set();

  // Fix HIGH #1 (head-of-line blocking): the previous design called the
  // Transform `callback(null, response)` INSIDE forwardRequest's `.then()`,
  // which made the stream wait for the HTTP round-trip before reading the
  // next stdin chunk. That serialised all MCP traffic and broke
  // notifications/cancellation. The fix: call `callback()` immediately
  // after parsing the line, freeing the stream to read more input; use
  // `this.push(...)` to emit responses asynchronously as they arrive.
  // Out-of-order responses are allowed by JSON-RPC (clients correlate by
  // `id`).
  const lineTransform = new Transform({
    encoding: 'utf8',
    decodeStrings: false,
    transform(chunk, encoding, callback) {
      const t = this;
      const controller = new AbortController();
      abortControllers.add(controller);
      const promise = handleMessage(chunk, {
        tokenCache,
        pushFn: (out) => t.push(out),
        abortSignal: controller.signal
      })
        .catch((err) => {
          // Defensive backstop. handleMessage wraps forwardRequest in
          // try/catch and pushes a JSON-RPC error response on any throw —
          // so it should not reject. The remaining failure surface is the
          // pushFn itself: Transform.push() does not throw under normal
          // conditions but could in edge cases (e.g., stream destroyed
          // mid-pipeline during a SIGTERM race). Log and continue rather
          // than letting Node 25's default unhandled-rejection behaviour
          // terminate the process and drop other in-flight responses.
          log.error('handleMessage promise rejected unexpectedly', {
            error: err?.message ?? String(err)
          });
        })
        .finally(() => {
          inFlight.delete(promise);
          abortControllers.delete(controller);
        });
      inFlight.add(promise);
      callback(); // free the stream IMMEDIATELY — don't await forwardRequest
    },
    async flush(callback) {
      // Drain in-flight responses before signalling stream-end. Without
      // this, late-arriving responses would be lost when the readable side
      // closes.
      await Promise.allSettled([...inFlight]);
      callback();
    }
  });

  // Graceful shutdown — drain in-flight responses on SIGTERM/SIGINT with a
  // hard timeout cap so a wedged forwardRequest can't hang the process.
  //
  // Registered INSIDE main() (not at module load) so:
  //   (a) the closure over `inFlight` is correct (handlers can see in-flight
  //       responses);
  //   (b) test imports of this module don't accidentally install signal
  //       handlers that interfere with the test runner;
  //   (c) handlers are only active while the bridge is actually running.
  //
  // Without this drain, in-flight forwardRequest responses arriving between
  // SIGTERM and process.exit() would be dropped — fine for the typical
  // stdio-MCP-disconnect case (parent process is going away) but wrong if
  // the bridge ever runs under a process supervisor that expects graceful
  // shutdown. Reviewer 2026-05-17 flagged this as NIT; addressing
  // defensively while the branch is pre-merge.
  let shuttingDown = false;
  const drainTimeoutMs = 2000;
  const onShutdownSignal = async (signal) => {
    if (shuttingDown) {
      log.warn('Shutdown signal received again — forcing exit', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    log.info('Shutdown signal — draining in-flight responses', {
      signal,
      inFlightCount: inFlight.size
    });
    let timeoutHandle;
    const result = await Promise.race([
      Promise.allSettled([...inFlight]).then(() => 'drained'),
      new Promise((r) => {
        timeoutHandle = setTimeout(() => r('timeout'), drainTimeoutMs);
      })
    ]);
    // Code-cleanliness: cancel the timer once the race resolves. On the
    // drain-wins path this prevents a dangling timer reference (process.exit
    // would terminate before it fires, but clearing is the disciplined
    // form). On the timeout-wins path the timer has already fired and
    // clearTimeout is a no-op — safe to call unconditionally.
    clearTimeout(timeoutHandle);
    if (result === 'timeout') {
      log.warn(
        'Drain timed out — aborting in-flight requests then exiting',
        {
          droppedCount: inFlight.size,
          abortedRequests: abortControllers.size,
          drainTimeoutMs
        }
      );
      // Explicitly destroy each in-flight socket so the remote sees FIN/RST
      // rather than waiting for keepalive. Best practice for HTTP clients
      // exiting with active requests; impact is minimal at single-user
      // stdio-bridge scale but matters more if the bridge ever runs in a
      // higher-throughput context.
      for (const controller of abortControllers) {
        controller.abort();
      }
      // Brief delay so the OS can flush the FIN/RST packets before
      // process.exit kills us. 50ms is enough at LAN/Cloud Run RTT.
      await new Promise((r) => setTimeout(r, 50));
      process.exit(1);
    }
    log.info('Drain complete — exiting', { signal });
    process.exit(0);
  };
  process.on('SIGTERM', () => onShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => onShutdownSignal('SIGINT'));

  try {
    await pipeline(process.stdin, lineSplitter, lineTransform, process.stdout);
    log.info('Pipeline closed normally');
    process.exit(0);
  } catch (err) {
    log.error('Pipeline error', { error: err.message });
    process.exit(1);
  }
}

// ── Execution guard — skip when imported as a module by tests ───────────────

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  try {
    await main();
  } catch (err) {
    log.error('Uncaught error', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}
