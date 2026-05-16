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

// ── gcloud invocation — injectable for tests ────────────────────────────────

/**
 * Execute a gcloud command. Returns trimmed stdout.
 * Throws {message, stderr, code} on failure.
 *
 * Exported for unit-test injection; tests replace it with a stub.
 */
export async function execGcloud(args, { execFn = execFileAsync } = {}) {
  try {
    const { stdout } = await execFn(GCLOUD_BIN, args, { timeout: 15_000 });
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
  const isSAActive = activeAccount
    .toLowerCase()
    .endsWith('.iam.gserviceaccount.com');
  const isOnRequiredDomain = activeAccount.endsWith(
    `@${config.requiredDomain}`
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
const SA_EMAIL_SUFFIX = '.iam.gserviceaccount.com';

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

  // Shape B: humans omit --audiences (gcloud --audiences is service-account-
  // only — BS-3). SAs (or unknown legacy/test contexts) keep --audiences for
  // backwards compatibility and for the SA path that actually requires it.
  const isHumanActive =
    typeof activeAccount === 'string' &&
    !activeAccount.toLowerCase().endsWith(SA_EMAIL_SUFFIX);

  return {
    /** Returns a fresh token, minting + caching as needed. */
    async getToken() {
      const t = now();
      if (cachedToken && t - mintedAt < lifetimeMs - refreshBeforeMs) {
        return cachedToken;
      }

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
        failFn(
          `Failed to mint Google ID token: ${err.message}`,
          'Common causes:',
          `  1. Expired credentials — run: gcloud auth login`,
          `  2. Wrong active project — check: gcloud config get-value project`,
          `  3. PERMISSION_DENIED on impersonation — the SA you're configured to`,
          `     impersonate may not grant you roles/iam.serviceAccountTokenCreator,`,
          `     OR you have not been added to the relevant role binding yet.`
        );
        return; // failFn is process.exit in prod; tests inject a throwing stub
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
          return;
        }

        if (typeof claims.email !== 'string') {
          failFn(
            'gcloud minted a token with no `email` claim.',
            'This almost always means gcloud is configured to impersonate a',
            'service account (via "gcloud config set',
            'auth/impersonate_service_account", the',
            'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT env var, a wrapper script,',
            'or similar). The IAM Credentials API mints impersonation tokens',
            'without the email claim by default. The bridge owns the gcloud',
            'invocation — you cannot add a flag to fix this; the impersonation',
            'config itself is the root cause.',
            '',
            'To fix:',
            '  1. gcloud config unset auth/impersonate_service_account',
            '  2. unset CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT  (if set)',
            '  3. Check for any wrapper script or alias around "gcloud"',
            '  4. Restart the bridge.',
            '',
            'Once impersonation is off, your default human token carries the',
            '`email` claim, and the bridge will accept it.'
          );
          return;
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
          return;
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
    },

    /** Force-invalidate the cache (used after a 401 from the gateway). */
    invalidate() {
      cachedToken = null;
      mintedAt = 0;
    },

    /** Test/diagnostic accessor. */
    _state() {
      return { cached: !!cachedToken, mintedAt };
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
    requestTimeoutMs = config.requestTimeoutMs
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
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
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

        try {
          resolve(JSON.parse(body));
        } catch (e) {
          log.error('Failed to parse gateway response', {
            parseError: e.message,
            id: message.id,
            bodyLength: body.length
          });
          resolve({
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' },
            id: message.id ?? null
          });
        }
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

    req.write(messageStr);
    req.end();
  });
}

// ── Main pipeline (line-based stdio) ─────────────────────────────────────────

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

  const lineSplitter = new Transform({
    transform(chunk, encoding, callback) {
      const str = (this.lastLine || '') + chunk.toString();
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

  const lineTransform = new Transform({
    transform(chunk, encoding, callback) {
      const line = chunk.toString();
      if (!line.trim()) {
        callback();
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (parseErr) {
        log.error('Failed to parse stdin line', {
          error: parseErr.message,
          line: line.slice(0, 100)
        });
        const errorResponse = {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null
        };
        callback(null, JSON.stringify(errorResponse) + '\n');
        return;
      }

      forwardRequest(message, { tokenCache })
        .then((response) => {
          callback(null, JSON.stringify(response) + '\n');
        })
        .catch((err) => {
          log.error('Unexpected forwardRequest error', { error: err.message });
          callback(
            null,
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal error' },
              id: message.id ?? null
            }) + '\n'
          );
        });
    }
  });

  try {
    await pipeline(process.stdin, lineSplitter, lineTransform, process.stdout);
    log.info('Pipeline closed normally');
    process.exit(0);
  } catch (err) {
    log.error('Pipeline error', { error: err.message });
    process.exit(1);
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  log.info('SIGTERM received');
  process.exit(0);
});
process.on('SIGINT', () => {
  log.info('SIGINT received');
  process.exit(0);
});

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
