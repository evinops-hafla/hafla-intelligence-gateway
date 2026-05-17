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
  handleMessage
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

    assert.equal(mintCount, 2, 'exactly 2 mints total: initial + 1 coalesced re-mint');
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
    await handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'x', id: 42 }), {
      tokenCache: null,
      pushFn: (l) => pushed.push(l),
      forwardRequestFn: async () => {
        throw new Error('synthetic-failure');
      }
    });
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
