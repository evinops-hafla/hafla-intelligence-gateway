/**
 * Unit tests for src/index.js (the intelligence-mcp-bridge entrypoint).
 *
 * Tests the token-cache + preFlight logic with injected gcloud + clock + http.
 * The bridge is structured so that execGcloud is mockable, createTokenCache
 * takes a custom executor + clock, and forwardRequest takes a custom http
 * request function.
 *
 * No real network or gcloud calls happen here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTokenCache,
  preFlight,
  forwardRequest,
  decodeJwtPayloadNoVerify
} from '../src/index.js';

// ── JWT-shaped token builder for cross-check tests ──────────────────────────
// Cross-check decodes the minted token's payload; tests need real JWT-shaped
// inputs (header.payload.fakesig) so the decoder doesn't reject them.
function makeJwt(payload) {
  const b64u = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(payload)}.fakesig`;
}

// Collects fail() calls instead of process.exit-ing. Tests assert the
// collected calls to verify both that fail fired AND what it said.
function collectingFailFn() {
  const calls = [];
  const fn = (...lines) => {
    calls.push(lines);
    // Mimic fail()'s control-flow side effect: caller treats fail() as
    // terminal and bails out via `return`. Tests therefore expect cachedToken
    // to remain unset on rejection paths.
  };
  fn.calls = calls;
  return fn;
}

// ── createTokenCache ────────────────────────────────────────────────────────

describe('createTokenCache', () => {
  test('mints on first call, returns cached on second call', async () => {
    let mintCalls = 0;
    const cache = createTokenCache({
      execGcloudFn: async () => {
        mintCalls += 1;
        return `token-${mintCalls}`;
      },
      lifetimeMs: 60_000,
      refreshBeforeMs: 5_000,
      now: () => 0
    });

    const t1 = await cache.getToken();
    const t2 = await cache.getToken();
    assert.equal(t1, 'token-1');
    assert.equal(t2, 'token-1');
    assert.equal(mintCalls, 1);
  });

  test('refreshes when within the refresh-before window', async () => {
    let mintCalls = 0;
    let nowValue = 0;
    const cache = createTokenCache({
      execGcloudFn: async () => {
        mintCalls += 1;
        return `token-${mintCalls}`;
      },
      lifetimeMs: 60_000,
      refreshBeforeMs: 5_000,
      now: () => nowValue
    });

    await cache.getToken(); // t=0 — mint
    nowValue = 50_000; // still well within fresh window
    await cache.getToken();
    assert.equal(mintCalls, 1);

    nowValue = 56_000; // inside the refresh-before window (>60000-5000)
    await cache.getToken();
    assert.equal(mintCalls, 2);
  });

  test('invalidate forces re-mint on next getToken', async () => {
    let mintCalls = 0;
    const cache = createTokenCache({
      execGcloudFn: async () => {
        mintCalls += 1;
        return `token-${mintCalls}`;
      },
      lifetimeMs: 60_000,
      refreshBeforeMs: 5_000,
      now: () => 0
    });

    await cache.getToken();
    assert.equal(mintCalls, 1);
    cache.invalidate();
    await cache.getToken();
    assert.equal(mintCalls, 2);
  });
});

// ── Shape B + post-mint identity cross-check (1.0.1 / BS-3 resolution) ─────
//
// Five enumerated cases per the canonical synthesis plan
// (`specs/.../research/2026-05-16-bs3-final-plan-synthesis.md` § Bridge 1.0.1):
//   (a) SA active + SA token same           → mint succeeds; no reject
//   (b) human active + same human token     → mint succeeds; no reject
//   (c) human active + SA token             → hard-reject (identity mismatch)
//   (d) human active + different-human token → hard-reject (identity mismatch)
//   (e) token has NO email claim            → hard-reject (missing email)

describe('createTokenCache — Shape B + identity cross-check', () => {
  test('(a) SA active + SA token: mints with --audiences; cross-check passes', async () => {
    const saEmail = 'mcp-gw-production-sa@hafla-backend-v1.iam.gserviceaccount.com';
    const seenArgs = [];
    const cache = createTokenCache({
      activeAccount: saEmail,
      execGcloudFn: async (args) => {
        seenArgs.push(args);
        return makeJwt({ email: saEmail });
      },
      audience: 'https://mcp.hafla.com',
      now: () => 0
    });
    const token = await cache.getToken();
    assert.ok(token, 'token must mint successfully');
    assert.deepEqual(seenArgs[0], [
      'auth',
      'print-identity-token',
      '--audiences=https://mcp.hafla.com'
    ]);
  });

  test('(b) human active + same human token: mints WITHOUT --audiences; cross-check passes', async () => {
    const human = 'sidd@hafla.com';
    const seenArgs = [];
    const cache = createTokenCache({
      activeAccount: human,
      execGcloudFn: async (args) => {
        seenArgs.push(args);
        return makeJwt({ email: human, hd: 'hafla.com' });
      },
      now: () => 0
    });
    const token = await cache.getToken();
    assert.ok(token, 'human-active mint must succeed under Path A multi-aud');
    assert.deepEqual(
      seenArgs[0],
      ['auth', 'print-identity-token'],
      '--audiences MUST be omitted for human active accounts (Shape B)'
    );
  });

  test('(c) human active + SA token (impersonation config): hard-rejects', async () => {
    const human = 'sidd@hafla.com';
    const saEmail = 'attacker-sa@evil-project.iam.gserviceaccount.com';
    const failFn = collectingFailFn();
    const cache = createTokenCache({
      activeAccount: human,
      execGcloudFn: async () => makeJwt({ email: saEmail }),
      failFn,
      now: () => 0
    });
    const result = await cache.getToken();
    assert.equal(result, undefined, 'getToken must return undefined when failFn fires');
    assert.equal(cache._state().cached, false, 'token must NOT be cached');
    assert.equal(failFn.calls.length, 1, 'failFn must be called exactly once');
    const message = failFn.calls[0].join('\n');
    assert.match(message, /Identity mismatch/);
    assert.match(message, new RegExp(saEmail.replace(/\./g, '\\.')));
    assert.match(message, /impersonate/i);
  });

  test('(d) human active + different-human token: hard-rejects', async () => {
    const active = 'sidd@hafla.com';
    const other = 'someone-else@hafla.com';
    const failFn = collectingFailFn();
    const cache = createTokenCache({
      activeAccount: active,
      execGcloudFn: async () => makeJwt({ email: other, hd: 'hafla.com' }),
      failFn,
      now: () => 0
    });
    await cache.getToken();
    assert.equal(cache._state().cached, false);
    const message = failFn.calls[0].join('\n');
    assert.match(message, /Identity mismatch/);
  });

  test('(e) token has NO email claim: hard-rejects with dedicated message', async () => {
    const human = 'sidd@hafla.com';
    const failFn = collectingFailFn();
    const cache = createTokenCache({
      activeAccount: human,
      execGcloudFn: async () => makeJwt({ sub: '12345' /* no email */ }),
      failFn,
      now: () => 0
    });
    await cache.getToken();
    assert.equal(cache._state().cached, false);
    const message = failFn.calls[0].join('\n');
    // Dedicated "missing email" framing — different from the identity-
    // mismatch path even though the root cause (impersonation config) is
    // usually the same.
    assert.match(message, /no `email` claim/);
    // Message must direct the operator at the actionable root cause
    // (unset impersonation config) — NOT at adding gcloud flags they
    // don't control (the bridge owns gcloud args).
    assert.match(message, /impersonat/);
    assert.match(message, /gcloud config unset auth\/impersonate_service_account/);
    assert.doesNotMatch(
      message,
      /Identity mismatch/,
      'missing-email path must use its own message, not the impersonation one'
    );
    assert.doesNotMatch(
      message,
      /--include-email/,
      'do NOT instruct the operator to add gcloud flags — the bridge owns the gcloud invocation; the operator cannot pass flags through'
    );
  });

  test('execGcloud throws PERMISSION_DENIED → catch-block surfaces actionable banner', async () => {
    // Covers the mint-itself-fails path (distinct from the mint-succeeds-
    // but-cross-check-rejects paths covered by tests (c) and (d)). Real
    // production triggers for this: operator's gcloud creds expired, or
    // tokenCreator role revoked mid-session, or — empirically-unverified —
    // gcloud's IAM Credentials API rejecting an impersonated mint that
    // lacks --audiences. All three surface here as a "Failed to mint"
    // banner so the catch-block is the single recovery point.
    const failFn = collectingFailFn();
    const cache = createTokenCache({
      activeAccount: 'sidd@hafla.com',
      execGcloudFn: async () => {
        const err = new Error(
          'PERMISSION_DENIED: Caller does not have permission roles/iam.serviceAccountTokenCreator on SA'
        );
        err.stderr =
          'ERROR: (gcloud.auth.print-identity-token) PERMISSION_DENIED ...';
        throw err;
      },
      failFn,
      now: () => 0
    });
    await cache.getToken();
    assert.equal(failFn.calls.length, 1);
    assert.equal(cache._state().cached, false);
    const message = failFn.calls[0].join('\n');
    assert.match(message, /Failed to mint Google ID token/);
    assert.match(message, /PERMISSION_DENIED/);
    assert.match(
      message,
      /roles\/iam\.serviceAccountTokenCreator/,
      'banner must name the missing role so operators know what to request'
    );
  });

  test('malformed JWT (wrong segment count) → catch-block surfaces decoder banner', async () => {
    // Exercises the post-mint decode path when execGcloud returns
    // something that does not parse as a JWT. The decodeJwtFn injection
    // point in createTokenCache exists for this scenario — without this
    // test it is unexercised API surface. We use the default decoder
    // (no injection) since a real gcloud-returns-garbage scenario does
    // not go through a custom decoder; the test thereby covers both the
    // decoder's segment-count guard AND the catch-block in getToken().
    const failFn = collectingFailFn();
    const cache = createTokenCache({
      activeAccount: 'sidd@hafla.com',
      execGcloudFn: async () => 'not-a-jwt-shape', // 1 segment → decoder throws
      failFn,
      now: () => 0
    });
    await cache.getToken();
    assert.equal(failFn.calls.length, 1);
    assert.equal(cache._state().cached, false);
    const message = failFn.calls[0].join('\n');
    assert.match(message, /does not parse as a JWT/);
    assert.match(message, /gcloud components update/);
  });

  test('case-insensitive identity match (active=Sidd@HAFLA.com vs token email=sidd@hafla.com)', async () => {
    const failFn = collectingFailFn();
    const cache = createTokenCache({
      activeAccount: 'Sidd@HAFLA.com',
      execGcloudFn: async () => makeJwt({ email: 'sidd@hafla.com', hd: 'hafla.com' }),
      failFn,
      now: () => 0
    });
    const token = await cache.getToken();
    assert.ok(token, 'case-variant active vs token must NOT be flagged as mismatch');
    assert.equal(failFn.calls.length, 0);
  });
});

describe('decodeJwtPayloadNoVerify', () => {
  test('decodes a valid JWT payload', () => {
    const claims = decodeJwtPayloadNoVerify(
      makeJwt({ email: 'a@b.com', hd: 'b.com' })
    );
    assert.equal(claims.email, 'a@b.com');
    assert.equal(claims.hd, 'b.com');
  });

  test('throws on a non-JWT string (wrong segment count)', () => {
    assert.throws(() => decodeJwtPayloadNoVerify('not.a-jwt'), /expected 3/);
    assert.throws(() => decodeJwtPayloadNoVerify('one-segment'), /expected 3/);
  });
});

// ── preFlight ───────────────────────────────────────────────────────────────
// preFlight calls process.exit on failure paths, so each failure-mode test
// would need to fork a child to assert exit codes. The success path is what
// we cover here. Real gcloud-not-installed scenarios are covered by smoke
// tests against the published package.

describe('preFlight', () => {
  test('returns active account on human happy path', async () => {
    const account = await preFlight({
      execGcloudFn: async (args) => {
        if (args[0] === 'auth' && args[1] === 'list') {
          return 'sidd@hafla.com';
        }
        throw new Error(`unexpected args: ${args.join(' ')}`);
      }
    });
    assert.equal(account, 'sidd@hafla.com');
  });

  test('returns active account on SA happy path (CI / Cloud Run / Vertex)', async () => {
    // Regression: an earlier draft of preFlight rejected any active account
    // not ending in @hafla.com, which would have blocked the SA-native flow
    // that createTokenCache's Shape B branch is explicitly designed to serve.
    // Code reviewer (2026-05-16) caught the contradiction; this test guards
    // against any future re-introduction.
    const saEmail =
      'mcp-gw-production-sa@hafla-backend-v1.iam.gserviceaccount.com';
    const account = await preFlight({
      execGcloudFn: async (args) => {
        if (args[0] === 'auth' && args[1] === 'list') {
          return saEmail;
        }
        throw new Error(`unexpected args: ${args.join(' ')}`);
      }
    });
    assert.equal(account, saEmail);
  });
});

// ── forwardRequest ──────────────────────────────────────────────────────────
// We build a minimal mock https.request via Node's EventEmitter pattern.

import { EventEmitter } from 'node:events';

function mockHttpRequest({ statusCode, body }) {
  return (options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      callback(res);
      setImmediate(() => {
        res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  };
}

describe('forwardRequest', () => {
  test('200 response is parsed and returned', async () => {
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    const result = await forwardRequest(
      { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      {
        tokenCache,
        httpRequestFn: mockHttpRequest({
          statusCode: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            result: { tools: [] },
            id: 1
          })
        }),
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
      }
    );
    assert.equal(result.id, 1);
    assert.deepEqual(result.result, { tools: [] });
  });

  test('401 invalidates the token cache', async () => {
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    await tokenCache.getToken();
    assert.equal(tokenCache._state().cached, true);

    await forwardRequest(
      { jsonrpc: '2.0', method: 'tools/list', id: 2 },
      {
        tokenCache,
        httpRequestFn: mockHttpRequest({
          statusCode: 401,
          body: '{"error":"unauthorized"}'
        }),
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
      }
    );

    assert.equal(tokenCache._state().cached, false);
  });

  test('invalid message returns -32600 without minting', async () => {
    let minted = 0;
    const tokenCache = createTokenCache({
      execGcloudFn: async () => {
        minted += 1;
        return 'fake';
      },
      now: () => 0
    });
    const result = await forwardRequest(null, {
      tokenCache,
      httpRequestFn: mockHttpRequest({ statusCode: 200, body: '{}' }),
      gatewayUrl: 'https://example.com',
      gatewayPath: '/mcp',
      requestTimeoutMs: 1000
    });
    assert.equal(result.error.code, -32600);
    assert.equal(minted, 0);
  });

  test('non-200 non-401 returns gateway error code', async () => {
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    const result = await forwardRequest(
      { jsonrpc: '2.0', method: 'tools/call', id: 3 },
      {
        tokenCache,
        httpRequestFn: mockHttpRequest({
          statusCode: 503,
          body: 'service unavailable'
        }),
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
      }
    );
    assert.equal(result.error.code, -32000);
    assert.match(result.error.message, /503/);
  });
});
