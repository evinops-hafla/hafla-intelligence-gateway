#!/usr/bin/env bash
# doctor.sh — preflight for the EvWA Intelligence plugin on the CLAUDE CODE path (macOS/Linux only).
#
# Serves the Claude Code / raw-MCP audience (the two-person dev team + technical users). Desktop users
# never run shell scripts, and at OAuth Stage 2 the connector auth is browser OAuth, not gcloud — so this
# is intentionally Code-only. Each check prints a one-line fix; exit 1 if any fails.
#
# It is a THIN wrapper over what the bridge already does at startup (gcloud installed + active account on
# hafla.com — see intelligence-mcp-bridge/src/index.js §Pre-flight). The truth test is a real tools/list
# through the bridge — NOT a gateway /health probe (that endpoint is unverified, and an unauthenticated
# health check wouldn't test auth, which is the thing that actually breaks).
#
# Usage:  bash scripts/doctor.sh [--skip-live]
set -u

FAILS=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n     → %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }

echo "EvWA plugin doctor — Claude Code path (macOS/Linux)"

# 1. Node >= 24 (+ warn on the version-manager / GUI-app path trap)
if ! command -v node >/dev/null 2>&1; then
  fail "node not found" "install Node 24 LTS (e.g. nvm install 24) — see the repo README"
else
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "${NODE_MAJOR:-0}" -ge 24 ] 2>/dev/null; then
    pass "node $(node -v)"
  else
    fail "node $(node -v) is < v24" "nvm install 24 && nvm use (this repo pins 24.15.0 in .nvmrc)"
  fi
  NODE_BIN=$(command -v node)
  case "$NODE_BIN" in
    *"/.nvm/"* | *"/.fnm/"* | *"/fnm/"* | *"/.volta/"*)
      warn "node resolves under a version-manager path ($NODE_BIN) — a GUI-launched Claude Desktop won't see it; the MCP config must use absolute node + bridge paths (see the bridge README launchd note)" ;;
  esac
fi

# 2. gcloud on PATH + active account on @hafla.com
if ! command -v gcloud >/dev/null 2>&1; then
  fail "gcloud not found" "install the Google Cloud CLI, then: gcloud auth login <you>@hafla.com"
else
  ACCT=$(gcloud config get-value account 2>/dev/null || true)
  case "$ACCT" in
    *"@hafla.com") pass "gcloud active account: $ACCT" ;;
    "") fail "no active gcloud account" "gcloud auth login <you>@hafla.com" ;;
    *) fail "active gcloud account is '$ACCT' (not @hafla.com)" "gcloud config set account <you>@hafla.com (or gcloud auth login)" ;;
  esac

  # 3. identity token actually mints
  if gcloud auth print-identity-token >/dev/null 2>&1; then
    pass "identity token mints"
  else
    fail "cannot mint an identity token" "gcloud auth login — your session may have expired"
  fi
fi

# 4. end-to-end: tools/list through the bridge (the real auth+reachability test)
GATEWAY_URL="${GATEWAY_URL:-https://mcp.hafla.com}"
if [ "${1:-}" = "--skip-live" ]; then
  warn "skipping the live gateway check (--skip-live)"
else
  echo "  … calling the gateway via the bridge (tools/list) — a few seconds…"
  RESP=$(printf '%s' '{"jsonrpc":"2.0","method":"tools/list","id":1}' | npx -y @hafla/intelligence-mcp-bridge 2>/dev/null | head -c 8000 || true)
  if printf '%s' "$RESP" | grep -q '"tools"'; then
    pass "gateway reachable — tools/list returned a tool list"
  elif printf '%s' "$RESP" | grep -qE 'Gateway returned 403|\b403\b'; then
    # The bridge masks the gateway's error body (just "Gateway returned 403"). The gateway distinguishes
    # several 403s with different fixes, so curl it directly with the SAME human token (plain gcloud
    # identity token — the bridge's human path also omits --audiences) to read the precise `detail`.
    DETAIL=""
    if command -v curl >/dev/null 2>&1; then
      TOK=$(gcloud auth print-identity-token 2>/dev/null || true)
      [ -n "$TOK" ] && DETAIL=$(curl -s -X POST "$GATEWAY_URL/mcp" \
        -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null | head -c 400 || true)
    fi
    case "$DETAIL" in
      *"token verification failed"*|*"Invalid token"*)
        # aud/iss mismatch — request REACHED the app (so IAM/group + isEmployeeActive are NOT the issue).
        # The usual cause: your gcloud credential was minted by a NON-standard OAuth client (e.g. Gemini
        # Code Assist / Cloud Code / a branded installer), so the token's `aud` isn't one the gateway accepts.
        fail "gateway 403 — token verification failed (audience mismatch, not a group/employee issue)" \
          "your gcloud identity token's aud isn't accepted. Re-auth with STANDARD gcloud: 'gcloud auth login' (vanilla CLI → the universal client the gateway accepts). If that doesn't fix it, your OAuth client ID must be added to the gateway's accepted audiences — ask ops (see gateway auth GCLOUD_OAUTH_CLIENT_ID)." ;;
      *"employee_inactive"*)
        fail "gateway 403 — account not flagged as an active employee" \
          "ask ops to set haflaCore.OpsUsers.isEmployeeActive=true for your @hafla.com account" ;;
      *"wrong_workspace_domain"*)
        fail "gateway 403 — Google account domain not allowlisted" \
          "sign in with your @hafla.com Google account (hd claim must be in the gateway's WORKSPACE_DOMAINS)" ;;
      *)
        fail "gateway returned 403 (couldn't read the precise reason)" \
          "run this to see it: gcloud auth print-identity-token | (read T; curl -s -X POST $GATEWAY_URL/mcp -H \"Authorization: Bearer \$T\" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'); then see the bridge README" ;;
    esac
  elif [ -n "$RESP" ]; then
    fail "gateway returned an error, not a tool list: $(printf '%s' "$RESP" | head -c 200)" \
      "re-run; if it persists see the bridge README troubleshooting"
  else
    fail "no response from the bridge" "check network + that npx could fetch @hafla/intelligence-mcp-bridge; re-run"
  fi
fi

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "✓ all checks passed — you're ready. Try: \"Who supplies chiavari chairs?\""
  exit 0
else
  echo "✗ $FAILS check(s) failed — fix the → lines above and re-run."
  exit 1
fi
