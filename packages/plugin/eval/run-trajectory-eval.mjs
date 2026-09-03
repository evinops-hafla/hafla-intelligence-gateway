#!/usr/bin/env node
// run-trajectory-eval.mjs — Tier-2 sampled trajectory eval.
//
// Tier 2 asserts SHAPE/GROUNDING (right skill, right tools, cited integer keys, no UUID, money
// labelled, freshness shown, no enum-error, no band-extreme quoted) — the pre-Desktop-launch
// regression net. Deliberately split into two credential profiles:
//
//   --check              structural validation of golden-trajectory.json (credential-free, CI-safe):
//                        every expectedSkill is a real skill, every assertion name is known, every
//                        expectedTool is a known gateway tool. Does NOT run the assertions — for that
//                        proof run `node assertions.mjs --self-test`.
//   --score <file>       score a RECORDED trajectories file against the golden spec (credential-free):
//                        no model, no gateway — it only inspects recorded answers + traces. A case
//                        passes iff ALL its assertions pass. This is the runnable, CI-safe scorer.
//
// Recording a trajectory (producing <file>) needs the Agent SDK + live gateway and is NOT done here —
// see eval/README.md. eval/samples/sample-trajectories.json holds real hand-recorded fixtures.
//
// A recorded record: { question, skill, trace: [{ tool, args?, error? }], answer }.
// Exit: 0 = pass, 1 = structural error / any scored case failed.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAssertion, ASSERTION_NAMES } from './assertions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const SKILLS_DIR = join(PLUGIN, 'skills');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const scoreIdx = argv.indexOf('--score');
const scoreFile = scoreIdx !== -1 ? argv[scoreIdx + 1] : null;

const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const knownTools = new Set(Object.keys(JSON.parse(readFileSync(join(HERE, '..', 'scripts', 'tool-schemas.json'), 'utf8')).tools));
const golden = JSON.parse(readFileSync(join(HERE, 'golden-trajectory.json'), 'utf8'));
const cases = golden.cases || [];
const norm = (q) => q.trim().toLowerCase().replace(/\s+/g, ' ');

// --- structural validation (always) ----------------------------------------------------------------
const structErrors = [];
const seen = new Set();
for (const [i, c] of cases.entries()) {
  if (!c.question) structErrors.push(`case ${i}: missing question`);
  if (!skillDirs.includes(c.expectedSkill)) structErrors.push(`case ${i} ("${c.question}"): expectedSkill "${c.expectedSkill}" is not a real skill`);
  for (const t of c.expectedTools || []) if (!knownTools.has(t)) structErrors.push(`case ${i} ("${c.question}"): expectedTool "${t}" not in tool-schemas.json`);
  for (const a of c.assertions || []) if (!ASSERTION_NAMES.includes(a)) structErrors.push(`case ${i} ("${c.question}"): unknown assertion "${a}"`);
  if (!(c.assertions || []).length) structErrors.push(`case ${i} ("${c.question}"): no assertions`);
  const k = norm(c.question);
  if (seen.has(k)) structErrors.push(`duplicate question: "${c.question}"`);
  seen.add(k);
}
if (structErrors.length) {
  console.log(`✗ golden-trajectory.json structural errors (${structErrors.length}):`);
  for (const e of structErrors) console.log(`   - ${e}`);
  process.exit(1);
}
const covered = new Set(cases.map((c) => c.expectedSkill));
const missingSkills = skillDirs.filter((s) => !covered.has(s));
console.log(`✓ structure OK — ${cases.length} cases, assertions/tools all known${missingSkills.length ? `, ⚠ skills without a case: ${missingSkills.join(', ')}` : ', all 6 skills covered'}.`);

if (checkOnly || !scoreFile) {
  if (!scoreFile) console.log('\nⓘ  Pass --score <trajectories.json> to score a recorded run. (Recording needs the Agent SDK + gateway; see eval/README.md.)');
  process.exit(0);
}

// --- score a recorded trajectories file (credential-free) ------------------------------------------
if (!existsSync(scoreFile)) { console.error(`✗ trajectories file not found: ${scoreFile}`); process.exit(1); }
const records = JSON.parse(readFileSync(scoreFile, 'utf8'));
const byQ = new Map(cases.map((c) => [norm(c.question), c]));

let casesPassed = 0, casesScored = 0;
const scoredQs = new Set();
for (const rec of records) {
  const c = byQ.get(norm(rec.question || ''));
  if (!c) { console.log(`   ? recorded question has no golden case: "${rec.question}"`); continue; }
  scoredQs.add(norm(rec.question));
  casesScored++;
  const results = c.assertions.map((name) => runAssertion(name, rec, c));
  const allPass = results.every((r) => r.pass);
  if (allPass) casesPassed++;
  console.log(`\n${allPass ? '✓' : '✗'} ${c.question}  [${c.expectedSkill}]`);
  for (const r of results) console.log(`     ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}

const uncovered = cases.filter((c) => !scoredQs.has(norm(c.question)));
console.log(`\nscored ${casesPassed}/${casesScored} cases green; ${uncovered.length} golden case(s) had no recorded trajectory${uncovered.length ? ` (${uncovered.map((c) => `"${c.question}"`).slice(0, 3).join(', ')}${uncovered.length > 3 ? '…' : ''})` : ''}.`);
if (casesScored === 0) { console.log('✗ FAIL — no recorded question matched a golden case'); process.exit(1); }
if (casesPassed < casesScored) { console.log('\n✗ FAIL — one or more scored cases failed a shape assertion'); process.exit(1); }
console.log('\n✓ PASS — every recorded trajectory satisfied its shape assertions');
