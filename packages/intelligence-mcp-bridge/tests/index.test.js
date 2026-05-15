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
  forwardRequest
} from '../src/index.js';

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

// ── preFlight ───────────────────────────────────────────────────────────────
// preFlight calls process.exit on failure paths, so each failure-mode test
// would need to fork a child to assert exit codes. The success path is what
// we cover here. Real gcloud-not-installed scenarios are covered by smoke
// tests against the published package.

describe('preFlight', () => {
  test('returns active account on happy path', async () => {
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
