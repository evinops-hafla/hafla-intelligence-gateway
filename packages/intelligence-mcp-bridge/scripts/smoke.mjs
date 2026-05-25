#!/usr/bin/env node
/**
 * F-1 install/invoke smoke test for @hafla/intelligence-mcp-bridge.
 *
 * Purpose: catch the symlink-class silent-exit bug (1.0.5 BS, 2026-05-25)
 * before tag-push. The bug was invisible to local dev because the dev cwd
 * had a local node_modules/ install that shadowed the global install. This
 * script reproduces the only invocation path that actually exercises the
 * global-symlink resolution: pack → install -g → npx from os.tmpdir().
 *
 * Steps:
 *   1. `npm pack` the local package → tarball in repo root
 *   2. Snapshot the current global install state (if any) so we can restore
 *   3. Uninstall any existing global @hafla/intelligence-mcp-bridge
 *   4. `npm install -g <tarball>`
 *   5. From os.tmpdir() (NEUTRAL cwd — no node_modules shadow), spawn
 *      `npx -y @hafla/intelligence-mcp-bridge`, pipe a JSON-RPC initialize
 *      to stdin, read response from stdout
 *   6. Assert handshake shape (jsonrpc, protocolVersion, serverInfo)
 *   7. Cleanup: restore prior global install state, remove tarball
 *
 * Cross-platform: Node stdlib only (child_process, fs, os, path, assert).
 * No bash, no shell expansion. Runs identically on macOS, Linux, Windows.
 *
 * Usage:
 *   cd packages/intelligence-mcp-bridge && node scripts/smoke.mjs
 *
 * Exits 0 on handshake success, non-zero on any failure.
 *
 * Environment requirements:
 * - User-writable global npm prefix. nvm / asdf / Volta / fnm and Homebrew
 *   node-on-/opt/homebrew satisfy this by default. Stock system Node with
 *   prefix at /usr/local/lib/node_modules requires either chowning the
 *   prefix to your user or setting a user-prefix via `npm config set
 *   prefix ~/.npm-global`. Do NOT run this script under sudo — sudo hides
 *   the misconfig signal and pollutes root-owned global state.
 * - The script enforces this at startup via assertGlobalPrefixWritable()
 *   so EACCES failures from `npm install -g` surface as a clear diagnostic
 *   instead of a confusing mid-run crash.
 *
 * Note on npx resolution (npm 11+):
 * - `npx` resolves globally installed packages via npm's internal prefix
 *   config (`npm config get prefix`) and the global node_modules cache —
 *   NOT via the POSIX shell PATH variable. Stripping the global bin
 *   directory from PATH does NOT cause silent fallback to a registry
 *   fetch (verified empirically against npm 11.15.0). The only way npx
 *   would fall back to fetching the broken 1.0.5 from the registry is a
 *   pathological npmrc misconfig where `prefix` points to a different
 *   directory than the one `npm install -g` actually wrote to, which no
 *   PATH check would detect anyway. This note exists so future reviewers
 *   don't re-raise the (mistaken) "PATH dependency" concern.
 */

import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  accessSync,
  constants as fsConstants
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const PKG_NAME = '@hafla/intelligence-mcp-bridge';
// Tarball basename starts with the package name with the leading "@" stripped
// and the "/" replaced by "-" (npm pack convention). Pre-derived once so the
// fallback glob in packPackage() can filter narrowly without false-matching
// stale tarballs left over from prior release iterations in the repo root.
const PKG_TARBALL_PREFIX = 'hafla-intelligence-mcp-bridge-';
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30_000;

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function logStep(msg) {
  process.stderr.write(`[smoke] ${msg}\n`);
}

function runNpm(args, opts = {}) {
  const result = spawnSync(npmCmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  });
  if (result.error) throw result.error;
  return result;
}

/**
 * Startup guard: prove the npm global prefix is writable by the current
 * user before doing anything destructive. EACCES from `npm install -g`
 * mid-run would otherwise leave the prior global install uninstalled but
 * not yet replaced — confusing half-state. Failing fast at startup keeps
 * the operator's machine in a known state.
 *
 * nvm / asdf / Volta / fnm and Homebrew-on-/opt/homebrew users pass this
 * trivially. Stock system Node with `/usr/local/lib/node_modules` as the
 * prefix will fail this check unless the operator owns that directory.
 * Sudo would mask the signal AND pollute root-owned global state, so the
 * error message explicitly tells the operator not to reach for sudo.
 */
function assertGlobalPrefixWritable() {
  const result = runNpm(['config', 'get', 'prefix']);
  const prefix = result.stdout.trim();
  if (!prefix) {
    throw new Error(
      '`npm config get prefix` returned empty — cannot determine global ' +
        'install destination. Check your npm installation.'
    );
  }
  try {
    accessSync(prefix, fsConstants.W_OK);
  } catch {
    throw new Error(
      `npm global prefix is not writable: ${prefix}\n` +
        `  This script needs to write to the global node_modules directory to\n` +
        `  pack-install-spawn the bridge end-to-end. Options:\n` +
        `    1. Use a version manager that owns its own prefix (nvm, asdf,\n` +
        `       Volta, fnm) — recommended.\n` +
        `    2. Reconfigure npm to a user-owned prefix:\n` +
        `         mkdir -p ~/.npm-global\n` +
        `         npm config set prefix ~/.npm-global\n` +
        `         export PATH=~/.npm-global/bin:$PATH\n` +
        `    3. (NOT RECOMMENDED) chown the existing prefix to your user.\n` +
        `  Do NOT run this script under sudo — sudo hides the misconfig\n` +
        `  signal AND pollutes root-owned global state.`
    );
  }
  logStep(`global prefix writable: ${prefix}`);
}

/**
 * Register SIGINT / SIGTERM handlers that print the manual recovery recipe
 * before exiting. We deliberately do NOT attempt full emergency cleanup
 * inside the handler — each `npm uninstall -g` / `npm install -g` is a
 * multi-second spawnSync that itself blocks SIGINT delivery and can be
 * interrupted again, producing worse half-state than no handler at all.
 * The handler's contract is "operator gets actionable recovery commands
 * the moment they Ctrl-C", not "machine ends in pristine state".
 *
 * Refs to tarball + prior-state are passed by-handle (objects with .value)
 * so the closure picks up state mutated AFTER handler registration without
 * re-registering on every state change.
 */
function registerShutdownHandlers({ tarballRef, priorRef }) {
  const onSignal = (signal) => {
    process.stderr.write(
      `\n[smoke] interrupted by ${signal}. Global npm state may be modified.\n` +
        `[smoke] Manual recovery commands:\n` +
        `  npm uninstall -g ${PKG_NAME}\n`
    );
    if (priorRef.value?.installed) {
      process.stderr.write(
        `  npm install -g ${PKG_NAME}@${priorRef.value.version}\n`
      );
    }
    if (tarballRef.value && existsSync(tarballRef.value)) {
      process.stderr.write(`  rm '${tarballRef.value}'\n`);
    }
    // 130 is the conventional "interrupted by SIGINT" exit code. Some CI
    // runners (notably GitHub Actions) inspect this for run-status framing.
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

function snapshotGlobalState() {
  // `npm ls -g <pkg> --json --depth=0` returns the installed version if any.
  // Exit code is non-zero when the package isn't installed; that's fine, we
  // parse the JSON either way.
  const result = runNpm(['ls', '-g', PKG_NAME, '--json', '--depth=0']);
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const installed = parsed.dependencies?.[PKG_NAME];
    if (installed?.version) {
      logStep(`prior global install detected: ${PKG_NAME}@${installed.version}`);
      return { installed: true, version: installed.version };
    }
  } catch {
    // Treat parse failure as "no prior install"; nothing to restore.
  }
  logStep('no prior global install detected');
  return { installed: false, version: null };
}

function uninstallGlobal() {
  logStep(`uninstalling global ${PKG_NAME} (if present)`);
  // Ignore failures — package may not be installed.
  runNpm(['uninstall', '-g', PKG_NAME]);
}

function installGlobalFromTarball(tarball) {
  logStep(`installing ${tarball} globally`);
  const result = runNpm(['install', '-g', tarball]);
  if (result.status !== 0) {
    throw new Error(
      `npm install -g failed (exit ${result.status}):\n${result.stderr}`
    );
  }
}

function restoreGlobalState(prior) {
  if (!prior.installed) return;
  logStep(`restoring prior global ${PKG_NAME}@${prior.version}`);
  // Re-install from the registry at the snapshotted version. Best-effort:
  // if it fails, the operator can `npm i -g <pkg>@<version>` manually.
  const result = runNpm(['install', '-g', `${PKG_NAME}@${prior.version}`]);
  if (result.status !== 0) {
    process.stderr.write(
      `[smoke] WARNING: failed to restore prior install ` +
        `(${PKG_NAME}@${prior.version}). Reinstall manually:\n` +
        `  npm install -g ${PKG_NAME}@${prior.version}\n`
    );
  }
}

function packPackage() {
  logStep(`npm pack in ${PKG_DIR}`);
  const result = runNpm(['pack', '--json'], { cwd: PKG_DIR });
  if (result.status !== 0) {
    throw new Error(`npm pack failed (exit ${result.status}):\n${result.stderr}`);
  }
  // `npm pack --json` prints an array of one entry with `filename`.
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`npm pack --json output not parseable: ${err.message}`);
  }
  const filename = Array.isArray(parsed) ? parsed[0]?.filename : null;
  if (!filename) {
    throw new Error('npm pack --json produced no filename');
  }
  // npm 11 emits the basename only; the file lives in PKG_DIR.
  const tarballPath = resolve(PKG_DIR, filename);
  if (!existsSync(tarballPath)) {
    // Some npm versions emit a scoped subpath; fall back to globbing the dir.
    // Filter by package-name prefix so stale .tgz files from prior release
    // iterations (or other packages packed into the same dir) don't poison
    // the candidate set. Without the prefix filter, a single stale tgz
    // would force candidates.length !== 1 and throw spuriously.
    const candidates = readdirSync(PKG_DIR).filter(
      (n) => n.startsWith(PKG_TARBALL_PREFIX) && n.endsWith('.tgz')
    );
    if (candidates.length === 1) return resolve(PKG_DIR, candidates[0]);
    throw new Error(
      `pack reported ${filename} but file not found at ${tarballPath} ` +
        `(fallback glob found ${candidates.length} candidate(s) matching ` +
        `${PKG_TARBALL_PREFIX}*.tgz)`
    );
  }
  return tarballPath;
}

function invokeAndAssertHandshake() {
  // Spawn from os.tmpdir() — the neutral cwd that reproduces the 1.0.5 bug.
  // A monorepo cwd with a local install would shadow the global symlink
  // and hide the regression class.
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-bridge-smoke-'));
  logStep(`spawning npx -y ${PKG_NAME} from ${cwd}`);

  return new Promise((resolveP, rejectP) => {
    const child = spawn(npxCmd, ['-y', PKG_NAME], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore — process may already have exited
      }
      rmSync(cwd, { recursive: true, force: true });
      if (err) rejectP(err);
      else resolveP(value);
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `Timed out after ${TIMEOUT_MS}ms waiting for JSON-RPC response.\n` +
            `stdout: ${stdoutBuf}\nstderr: ${stderrBuf}`
        )
      );
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      // The bridge emits one JSON object per newline-terminated line.
      const newlineIdx = stdoutBuf.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = stdoutBuf.slice(0, newlineIdx);
      let response;
      try {
        response = JSON.parse(line);
      } catch (err) {
        clearTimeout(timer);
        finish(new Error(`stdout line is not JSON: ${line} (${err.message})`));
        return;
      }
      clearTimeout(timer);
      finish(null, response);
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    child.on('close', (code) => {
      // If we already settled with a response, this is just the post-kill
      // exit; ignore. If not settled, the bridge exited without ever
      // responding — the exact 1.0.5 silent-exit failure mode.
      if (settled) return;
      clearTimeout(timer);
      finish(
        new Error(
          `Bridge exited with code ${code} before producing JSON-RPC response.\n` +
            `This is the 1.0.5 symlink silent-exit signature.\n` +
            `stdout: ${stdoutBuf}\nstderr: ${stderrBuf}`
        )
      );
    });

    // Send a JSON-RPC initialize request per the MCP spec.
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' }
      }
    };
    child.stdin.write(JSON.stringify(initRequest) + '\n');
  });
}

function assertHandshakeShape(response) {
  assert.equal(response.jsonrpc, '2.0', 'response.jsonrpc must be "2.0"');
  assert.equal(response.id, 1, 'response.id must echo the request id');
  // initialize response carries result.protocolVersion + result.serverInfo
  // when the gateway is reachable; if the gateway returns an error the
  // response will have `error` instead — both shapes prove the bridge
  // itself is alive (not the 1.0.5 silent-exit class).
  assert.ok(
    response.result || response.error,
    'response must have result or error (proof bridge is alive)'
  );
  if (response.result) {
    assert.ok(
      response.result.protocolVersion,
      'result.protocolVersion must be present'
    );
    assert.ok(response.result.serverInfo, 'result.serverInfo must be present');
  }
}

async function main() {
  // Fail fast on EACCES before any destructive npm command.
  assertGlobalPrefixWritable();

  // Register signal handlers with by-handle refs so the closures pick up
  // tarball + prior state as they get populated below. SIGINT/SIGTERM
  // skip the finally{} arm in async functions (Node terminates without
  // running pending awaits), so the handler is our only chance to tell
  // the operator how to recover. Verified empirically — see CHANGELOG /
  // commit message.
  const tarballRef = { value: null };
  const priorRef = { value: null };
  registerShutdownHandlers({ tarballRef, priorRef });

  priorRef.value = snapshotGlobalState();
  let exitCode = 0;
  try {
    tarballRef.value = packPackage();
    uninstallGlobal();
    installGlobalFromTarball(tarballRef.value);
    const response = await invokeAndAssertHandshake();
    assertHandshakeShape(response);
    logStep('PASS — JSON-RPC initialize handshake completed');
  } catch (err) {
    process.stderr.write(`[smoke] FAIL — ${err.message}\n`);
    exitCode = 1;
  } finally {
    uninstallGlobal();
    restoreGlobalState(priorRef.value);
    if (tarballRef.value && existsSync(tarballRef.value)) {
      rmSync(tarballRef.value, { force: true });
    }
  }
  process.exit(exitCode);
}

await main();
