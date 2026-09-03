#!/usr/bin/env bash
# pack-skills.sh — zip each skill folder for per-user upload to Claude Desktop / claude.ai.
#
# Claude.ai custom Skills install as a ZIP of the skill folder (Customize → Skills → Add).
# This produces one <skill>.zip per skill, each containing <skill>/SKILL.md (+ any resources).
#
# Usage:
#   bash packages/plugin/scripts/pack-skills.sh            # → packages/plugin/dist/*.zip
#   OUT_DIR=/tmp/evwa-skills bash .../pack-skills.sh       # custom output dir
#
# Output dir is .gitignored — do NOT commit the zips (they are build artifacts;
# the SKILL.md folders are the source of truth). Re-run after any skill edit.
set -euo pipefail

# Resolve the plugin root (parent of this scripts/ dir) regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$PLUGIN_DIR/skills"
OUT_DIR="${OUT_DIR:-$PLUGIN_DIR/dist}"

command -v zip >/dev/null || { echo "error: 'zip' not found on PATH" >&2; exit 1; }
[ -d "$SKILLS_DIR" ] || { echo "error: skills dir not found: $SKILLS_DIR" >&2; exit 1; }

# Gate: don't package skills that fail static verification (params/frontmatter/routing/conventions).
# Set SKIP_VERIFY=1 to bypass (not recommended). A MISSING node is an error, not a silent skip —
# otherwise "no node on PATH" would package unverified skills indistinguishably from a passing run.
if [ "${SKIP_VERIFY:-0}" = "1" ]; then
  echo "⚠ SKIP_VERIFY=1 — packaging WITHOUT static verification." >&2
elif command -v node >/dev/null; then
  echo "verifying skills before packaging…"
  node "$SCRIPT_DIR/verify-skills.mjs" || { echo "error: verify-skills failed — fix errors or SKIP_VERIFY=1 to override" >&2; exit 1; }
else
  echo "error: 'node' not found — cannot run verify-skills. Install Node 24 (see repo README), or SKIP_VERIFY=1 to bypass." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
count=0
for skill_path in "$SKILLS_DIR"/*/; do
  skill="$(basename "$skill_path")"
  [ -f "$skill_path/SKILL.md" ] || { echo "skip: $skill (no SKILL.md)"; continue; }
  # Build the zip from inside skills/ so the archive contains <skill>/SKILL.md (folder preserved).
  ( cd "$SKILLS_DIR" && rm -f "$OUT_DIR/$skill.zip" && zip -q -r "$OUT_DIR/$skill.zip" "$skill" )
  echo "packed: $OUT_DIR/$skill.zip"
  count=$((count + 1))
done

echo "done — $count skill zip(s) in $OUT_DIR"
echo "each teammate: Claude Desktop → Customize → Skills → Add → upload the zip (code execution must be enabled)."
