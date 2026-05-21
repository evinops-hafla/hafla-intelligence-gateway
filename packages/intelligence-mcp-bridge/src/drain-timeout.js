/**
 * Parse the BRIDGE_SHUTDOWN_DRAIN_MS env var into a finite millisecond
 * timeout, falling back to the default on any non-numeric value.
 *
 * Why this helper exists rather than inline `Number.parseInt(env, 10)`:
 *   `Number.parseInt('abc', 10)` returns `NaN`. `setTimeout(_, NaN)`
 *   silently coerces the duration to 0, causing the shutdown drain to
 *   exit immediately and drop in-flight responses — the exact bug
 *   the drain is meant to prevent. `Number.isFinite` rejects NaN
 *   while preserving 0 (an operator who sets =0 wants "no drain",
 *   which is a legitimate choice — `|| 2000` would silently override
 *   that).
 *
 * Reported by gemini-code-assist on PR #3
 * (https://github.com/evinops-hafla/hafla-intelligence-gateway/pull/3#discussion_r3276101373).
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 2000;

export function parseDrainTimeoutMs(rawValue) {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_DRAIN_TIMEOUT_MS;
}
