# Changelog

All notable changes to `@hafla/intelligence-mcp-bridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-05-16

### Fixed

- **BS-3 resolution.** 1.0.0 unconditionally passed `--audiences=$GATEWAY_AUDIENCE` to `gcloud auth print-identity-token` — a service-account-only flag. Running from a human `@hafla.com` account produced `Invalid account type for --audiences. Requires valid service account.` and the bridge could not mint a usable token for any human user. 1.0.1 implements **Shape B**: omit `--audiences` when the active gcloud account is human; keep it when the active account is a service account.

### Added

- **Post-mint identity cross-check (hard-reject).** After minting, the bridge decodes the JWT payload and compares the token's `email` claim against the active gcloud account. If they differ — almost always because `gcloud config set auth/impersonate_service_account` (or the equivalent env var / wrapper) is in effect — the bridge hard-rejects with a multi-step recovery checklist. This protects D-4's "verified email claim IS the user identity" property at the bridge layer; warning-and-passing would silently erase the operator's identity from the gateway audit trail.
- New exported `decodeJwtPayloadNoVerify(token)` — minimal base64-url JWT-payload decoder (no signature verification; the gateway re-verifies via jose against Google JWKS). Used by the cross-check.

### Verification

- Cross-check correctness validated against **gcloud SDK 568.0.0**: empirical test confirmed `gcloud auth list --filter=status:ACTIVE` returns the underlying human account even when `auth/impersonate_service_account` is configured (the impersonation is an API-level override applied on top of the active credential). **Re-verify on any gcloud SDK major-version bump** — if `gcloud auth list` ever starts reporting the impersonated SA as active, the cross-check needs a different detection mechanism.
- One half of the empirical proof remains pending: confirming that `gcloud auth print-identity-token` actually mints AS the SA under impersonation config (operator has no `tokenCreator` binding on any SA to test locally). The cross-check fires correctly either way: real impersonation → mismatch → reject; silent fallback to user-mint → match → pass. Worth verifying on the first machine where `tokenCreator` is granted.

### Compatibility

- Source-level breaking changes to `createTokenCache`: new optional `activeAccount`, `failFn`, `decodeJwtFn` parameters. When `activeAccount` is null (the 1.0.0 call shape), behaviour is identical to 1.0.0 — `--audiences` is always passed, no cross-check runs. The new defaults activate only when `main()` wires the value through from `preFlight()`. **No breaking change for the npx-bin use case** that operators actually consume.

### Cross-references

- Canonical resolution plan: <https://github.com/evinops-hafla/hafla-intelligence/blob/research/bs3-resolution-discovery/mcp-gateway/specs/history-and-future/history/research/2026-05-16-bs3-final-plan-synthesis.md> (private repo)
- Gateway-side changes (multi-audience + `hd` guard): private repo commit `48e37cb3`

## [1.0.0] — 2026-05-16

### Added

- Initial public release. Extracted from the private monorepo's `hafla-intelligence/mcp-gateway/scripts/mcp-gateway-bridge.js`.
- stdio↔HTTPS bridge with 60-minute Google ID token minting via `gcloud auth print-identity-token`, in-memory cache with 5-min refresh-ahead window, and 401-triggered cache invalidation.
- Pre-flight checks: gcloud installed, an `@hafla.com` account is the active one.
- Runtime diagnostic banners for the four most common failure modes (gcloud not found, wrong-domain account, 401 audience mismatch, 403 employee_inactive).
- Cross-platform support — Windows is handled by a `GCLOUD_BIN` constant that picks `gcloud.cmd` over `gcloud` based on `process.platform`.
- Zero npm runtime dependencies — Node ≥20 stdlib only.
