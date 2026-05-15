# Changelog

All notable changes to `@hafla/intelligence-mcp-bridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-16

### Added

- Initial public release. Extracted from the private monorepo's `hafla-intelligence/mcp-gateway/scripts/mcp-gateway-bridge.js`.
- stdio↔HTTPS bridge with 60-minute Google ID token minting via `gcloud auth print-identity-token`, in-memory cache with 5-min refresh-ahead window, and 401-triggered cache invalidation.
- Pre-flight checks: gcloud installed, an `@hafla.com` account is the active one.
- Runtime diagnostic banners for the four most common failure modes (gcloud not found, wrong-domain account, 401 audience mismatch, 403 employee_inactive).
- Cross-platform support — Windows is handled by a `GCLOUD_BIN` constant that picks `gcloud.cmd` over `gcloud` based on `process.platform`.
- Zero npm runtime dependencies — Node ≥20 stdlib only.
