// gemini.mjs — Google AI Studio (Gemini) generateContent, single-turn text completion. Zero deps.
//
// Part of the eval provider layer (see ./index.mjs). Gemini is a cross-model PROXY for the routing eval:
// it measures whether the skill descriptions are discriminative, but production routing is Claude, so a
// Claude run stays canonical (index.mjs surfaces `canonical` so the caller can print the caveat).

export const label = 'gemini';
export const canonical = false;
// A light, always-current alias — routing is a single-token task (the Anthropic side uses haiku for the
// same reason), and `-latest` auto-tracks so the default never goes stale. Set EVAL_MODEL=gemini-2.5-pro
// (or gemini-pro-latest) for the strongest model.
export const DEFAULT_MODEL = 'gemini-flash-latest';

export function hasKey(env = process.env) {
  return !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns the model's raw text (caller normalizes). Throws `Gemini <status>: <body>` on non-2xx.
// maxTokens defaults high (512) so a "thinking" model still has budget to emit the visible answer.
// Retries 429/503 honoring the server's retryDelay — a free-tier key (~5 req/min) will 429 partway
// through a multi-case run, and pacing beats aborting.
export async function complete({
  system,
  user,
  model = DEFAULT_MODEL,
  maxTokens = 512,
  temperature = 0,
  env = process.env,
  maxRetries = 6
}) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  // Key in the header, not the URL query — keeps it out of server/proxy access logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature }
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body
    });
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      const errText = await res.text();
      const m = errText.match(/"retryDelay":\s*"([\d.]+)s"/);
      const waitMs = Math.min(
        (m ? parseFloat(m[1]) * 1000 : 2 ** attempt * 1000) + 500,
        60000
      );
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('');
  }
}
