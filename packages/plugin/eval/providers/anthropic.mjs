// anthropic.mjs — Anthropic Messages API, single-turn text completion. Zero deps (native fetch).
//
// Part of the eval provider layer (see ./index.mjs). Anthropic is the CANONICAL router for the routing
// eval: production skill-routing is done by Claude, so a Claude run is the reference measure.

export const label = 'anthropic';
export const canonical = true;
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export function hasKey(env = process.env) {
  return !!env.ANTHROPIC_API_KEY;
}

// Returns the model's raw text (caller normalizes). Throws `Anthropic <status>: <body>` on non-2xx.
export async function complete({
  system,
  user,
  model = DEFAULT_MODEL,
  maxTokens = 16,
  env = process.env
}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}
