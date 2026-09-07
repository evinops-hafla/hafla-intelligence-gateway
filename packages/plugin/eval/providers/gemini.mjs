// gemini.mjs — Google AI Studio (Gemini) generateContent, single-turn text completion. Zero deps.
//
// Part of the eval provider layer (see ./index.mjs). Gemini is a cross-model PROXY for the routing eval:
// it measures whether the skill descriptions are discriminative, but production routing is Claude, so a
// Claude run stays canonical (index.mjs surfaces `canonical` so the caller can print the caveat).

export const label = 'gemini';
export const canonical = false;
export const DEFAULT_MODEL = 'gemini-2.5-pro';

export function hasKey(env = process.env) {
  return !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
}

// Returns the model's raw text (caller normalizes). Throws `Gemini <status>: <body>` on non-2xx.
// maxTokens defaults high (512) so a "thinking" model still has budget to emit the visible answer.
export async function complete({
  system,
  user,
  model = DEFAULT_MODEL,
  maxTokens = 512,
  temperature = 0,
  env = process.env
}) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature }
    })
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
}
