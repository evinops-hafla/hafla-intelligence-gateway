#!/usr/bin/env node
// run-routing-eval.mjs — Tier-1 routing eval for the EvWA skills.
//
// Asks: given ONLY the 6 frontmatter descriptions, does a question route to the right skill?
// This is the one dimension the static harness (verify-skills.mjs) cannot cover — it checks param
// *names*, not which *description* wins — and the only durable net for the semantically-wrong /
// schema-valid class (e.g. event_playbook family="Wedding"), which passes every static gate and only
// fails live. It is also the regression guard for shortening/front-loading the descriptions.
//
// Two modes:
//   --check            structural validation only (credential-free — safe to run anywhere, incl. CI).
//                      Asserts every golden expectedSkill is a real skill (or "out-of-scope"), no
//                      duplicate questions, and each of the 6 skills is covered by >=1 case.
//   (default)          the real routing eval. Needs ANTHROPIC_API_KEY. For each golden question it
//                      gives a model ONLY the 6 name+description pairs and asks for the single skill
//                      that should trigger, then scores against golden-routing.json.
//
// Deliberately NOT wired into ci.yml — the model call needs a credential and costs tokens; the
// credential-free gate (verify-skills.mjs) stays the CI net. Run this by hand after any description edit.
//
// Usage:  node packages/plugin/eval/run-routing-eval.mjs [--check] [--verbose]
// Env:    ANTHROPIC_API_KEY (required for the real run), EVAL_MODEL (default claude-haiku-4-5-20251001).
// Exit:   0 = pass (structural clean / accuracy >= threshold), 1 = fail.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const SKILLS_DIR = join(PLUGIN, 'skills');
const checkOnly = process.argv.includes('--check');
const verbose = process.argv.includes('--verbose');
const MODEL = process.env.EVAL_MODEL || 'claude-haiku-4-5-20251001';
const THRESHOLD = 0.95; // Tier-1 acceptance: >=95% routing accuracy (a miss is a description bug OR a golden-label bug — both worth finding)

const OUT_OF_SCOPE = 'out-of-scope';

// --- load the 6 skill descriptions (the ONLY signal the host uses to route) ------------------------
function loadDescription(skillDir) {
  const text = readFileSync(join(SKILLS_DIR, skillDir, 'SKILL.md'), 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const body = fm[1];
  const lines = body.split('\n');
  const di = lines.findIndex((l) => /^description:/.test(l));
  if (di === -1) return null;
  // inline value?
  const inline = lines[di].replace(/^description:\s*/, '').trim();
  if (inline && !/^[|>][+-]?\d*$/.test(inline)) return inline;
  // folded/block scalar: gather until the next top-level key
  const buf = [];
  for (let i = di + 1; i < lines.length; i++) {
    if (/^[a-zA-Z_][\w-]*:/.test(lines[i])) break;
    buf.push(lines[i].trim());
  }
  return buf.join(' ').trim();
}

const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
const descriptions = new Map();
for (const s of skillDirs) {
  const d = loadDescription(s);
  if (!d) { console.error(`✗ could not read description for ${s}`); process.exit(1); }
  descriptions.set(s, d);
}
const validTargets = new Set([...skillDirs, OUT_OF_SCOPE]);

// --- load + structurally validate the golden set ---------------------------------------------------
const golden = JSON.parse(readFileSync(join(HERE, 'golden-routing.json'), 'utf8'));
const cases = golden.cases || [];
const structErrors = [];
const seen = new Set();
const covered = new Set();
for (const [i, c] of cases.entries()) {
  if (!c.question || typeof c.question !== 'string') structErrors.push(`case ${i}: missing/invalid question`);
  if (!validTargets.has(c.expectedSkill)) structErrors.push(`case ${i} ("${c.question}"): expectedSkill "${c.expectedSkill}" is not a real skill or "${OUT_OF_SCOPE}"`);
  const key = c.question.trim().toLowerCase();
  if (seen.has(key)) structErrors.push(`duplicate question: "${c.question}"`);
  seen.add(key);
  if (c.expectedSkill !== OUT_OF_SCOPE) covered.add(c.expectedSkill);
}
for (const s of skillDirs) if (!covered.has(s)) structErrors.push(`skill "${s}" has no golden case — add at least one`);

if (structErrors.length) {
  console.log(`✗ golden-routing.json structural errors (${structErrors.length}):`);
  for (const e of structErrors) console.log(`   - ${e}`);
  process.exit(1);
}
console.log(`✓ structure OK — ${cases.length} cases, all 6 skills covered, ${cases.filter((c) => c.negative).length} seeded negatives, ${cases.filter((c) => c.expectedSkill === OUT_OF_SCOPE).length} out-of-scope.`);
if (checkOnly) process.exit(0);

// --- real routing eval (needs a credential) --------------------------------------------------------
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('\nⓘ  --check passed. To run the actual routing eval, set ANTHROPIC_API_KEY and re-run without --check.');
  process.exit(0);
}

const catalogue = skillDirs.map((s) => `- ${s}: ${descriptions.get(s)}`).join('\n');
const system = `You are the skill router for the EvWA Intelligence plugin. Given a user question and the catalogue of skills below, reply with EXACTLY ONE token: the name of the single skill that should handle it, or "${OUT_OF_SCOPE}" if none should (e.g. profit-margin or pricing-strategy questions). Output only the token — no punctuation, no explanation.\n\nSkills:\n${catalogue}`;

async function route(question) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16,
      system,
      messages: [{ role: 'user', content: question }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z-]/g, '');
}

let pass = 0;
const misses = [];
for (const c of cases) {
  let got;
  try { got = await route(c.question); }
  catch (e) { console.error(`✗ API error on "${c.question}": ${e.message}`); process.exit(1); }
  const ok = got === c.expectedSkill;
  if (ok) pass++;
  else misses.push({ q: c.question, expected: c.expectedSkill, got, negative: !!c.negative });
  if (verbose) console.log(`   ${ok ? '✓' : '✗'} ${c.question}  →  ${got}${ok ? '' : ` (expected ${c.expectedSkill})`}`);
}

const acc = pass / cases.length;
console.log(`\nrouting accuracy: ${pass}/${cases.length} = ${(acc * 100).toFixed(1)}%  (model: ${MODEL})`);
if (misses.length) {
  console.log('\nMISSES (a miss is either a description bug or a golden-label bug — investigate both):');
  for (const m of misses) console.log(`   ✗ "${m.q}"${m.negative ? ' [seeded negative]' : ''}\n       expected ${m.expected}, got ${m.got}`);
}
if (acc < THRESHOLD) { console.log(`\n✗ FAIL — accuracy ${(acc * 100).toFixed(1)}% < ${(THRESHOLD * 100)}% threshold`); process.exit(1); }
console.log(`\n✓ PASS — accuracy ${(acc * 100).toFixed(1)}% >= ${(THRESHOLD * 100)}% threshold`);
