// index.mjs — provider dispatcher for the eval LLM layer.
//
// Picks a provider from the environment and returns a uniform, ready-to-call handle. The per-provider
// modules (anthropic.mjs / gemini.mjs) hold the wire format; this file holds only the SELECTION policy,
// so callers depend on one small surface: `selectProvider(env) -> { name, model, canonical, complete } | null`.
//
// Selection:
//   - EVAL_PROVIDER=<name>  forces a provider (errors if unknown, or if its key is missing).
//   - otherwise the first provider in ORDER whose key is present wins — Anthropic before Gemini, because
//     Anthropic is the canonical router (production routing is Claude).
//   - no key at all -> null (the caller decides how to message that).
// EVAL_MODEL overrides the chosen provider's DEFAULT_MODEL.

import * as anthropic from './anthropic.mjs';
import * as gemini from './gemini.mjs';

const PROVIDERS = { anthropic, gemini };
const ORDER = ['anthropic', 'gemini'];

function build(name, env) {
  const p = PROVIDERS[name];
  const model = env.EVAL_MODEL || p.DEFAULT_MODEL;
  return {
    name,
    model,
    canonical: p.canonical,
    // model + env are bound here; callers pass only { system, user, ...overrides }.
    complete: (args) => p.complete({ model, env, ...args })
  };
}

export function selectProvider(env = process.env) {
  const forced = env.EVAL_PROVIDER;
  if (forced) {
    if (!PROVIDERS[forced]) {
      throw new Error(
        `EVAL_PROVIDER="${forced}" is not a known provider (${Object.keys(PROVIDERS).join(', ')})`
      );
    }
    if (!PROVIDERS[forced].hasKey(env)) {
      throw new Error(
        `EVAL_PROVIDER="${forced}" is set but its API key is missing`
      );
    }
    return build(forced, env);
  }
  for (const name of ORDER)
    if (PROVIDERS[name].hasKey(env)) return build(name, env);
  return null;
}
