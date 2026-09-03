#!/usr/bin/env node
// verify-skills.mjs — static, credential-free integrity checks for the EvWA Agent Skills.
//
// Catches the drift/bug classes this repo has actually hit:
//   1. Tool-call param drift   — e.g. price_anchor({ id }) when the tool takes productId (a live bug).
//   2. Frontmatter violations  — name/description missing or over claude.ai upload limits.
//   3. Routing-graph orphans   — a skill no sibling routes to, or that routes nowhere.
//   4. (report) embedded SQL/Cypher blocks — listed for the manual/live verification pass.
//
// Param validation is against packages/plugin/scripts/tool-schemas.json (a snapshot of the live
// gateway tool inputSchemas) — so this needs NO gateway access and runs in CI. Refresh the snapshot
// when the gateway changes a tool's params.
//
// Usage:  node packages/plugin/scripts/verify-skills.mjs [--list-queries]
// Exit:   0 = clean (warnings allowed), 1 = one or more ERRORs.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const SKILLS_DIR = join(PLUGIN, 'skills');
const listQueries = process.argv.includes('--list-queries');

const errors = [];
const warnings = [];
const err = (skill, msg) => errors.push(`  ✗ [${skill}] ${msg}`);
const warn = (skill, msg) => warnings.push(`  ! [${skill}] ${msg}`);

const schema = JSON.parse(readFileSync(join(HERE, 'tool-schemas.json'), 'utf8'));
const TOOLS = schema.tools;
const TOOL_NAMES = Object.keys(TOOLS);

// Shared output-conventions block: fenced by these markers, must be byte-identical across all skills
// (a Desktop zip ships only its own SKILL.md, so the block has to live inside each — a README copy is
// invisible at answer time). The cross-skill identity check below is what prevents the 6 copies drifting.
const CONV_START = '<!-- OUTPUT-CONVENTIONS:START';
const CONV_END = 'OUTPUT-CONVENTIONS:END -->';

// Description front-loading: the first ~200 chars are all the claude.ai UI reliably shows, so each
// skill's disambiguating trigger must live there. At least one phrase per skill must appear in slice(0,200).
const TRIGGER_PHRASES = {
  'supplier-discovery': ['supplies', 'supplier'],
  'pricing-lookup': ['cost'],
  'product-brief': ['brief', '101'],
  'past-orders': ['before', 'history'],
  'venue-recommendation': ['venue'],
  'event-needs': ['need']
};

// --- helpers ---------------------------------------------------------------

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const body = m[1];
  const name = (body.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
  // description may be a `>-` folded block spanning lines until the next top-level key
  let description = (body.match(/^description:\s*(.+)$/m) || [])[1]?.trim();
  if (description === undefined || /^[|>][+-]?\d*$/.test(description)) { // any YAML block scalar: | > |- >- |+ >+ |2 …
    const lines = body.split('\n');
    const di = lines.findIndex((l) => /^description:/.test(l));
    const buf = [];
    for (let i = di + 1; i < lines.length; i++) {
      if (/^[a-zA-Z_][\w-]*:/.test(lines[i])) break; // next top-level key
      buf.push(lines[i].trim());
    }
    description = buf.join(' ').trim();
  }
  return { name, description };
}

// Extract the balanced {...} object body starting at index `open` (which points at '{').
function balancedObject(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(open + 1, i);
    }
  }
  return null; // unbalanced
}

// Split a params body on top-level commas (ignoring commas inside nested {} or []).
function topLevelSplit(body) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of body) {
    if (c === '{' || c === '[') { depth++; cur += c; }
    else if (c === '}' || c === ']') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// From a params body, return the set of top-level param KEYS the call passes.
// NOTE: only TOP-LEVEL keys are validated. Fields inside a nested object/array literal
// (e.g. delivery_fee `items: [{ category, quantity, ... }]`) are NOT shape-checked here.
function extractKeys(body) {
  const keys = [];
  for (const seg of topLevelSplit(body)) {
    let key = seg.split(':')[0].trim();      // key before ':' (or whole segment if shorthand)
    if (!key) continue;
    for (let k of key.split('|')) {           // handle `id|slug|productNumber` option shorthand
      k = k.trim().replace(/\?$/, '');        // strip optional marker `venueType?`
      if (/^[a-zA-Z_][\w]*$/.test(k)) keys.push(k);
    }
  }
  return keys;
}

// --- load skills -----------------------------------------------------------

if (!existsSync(SKILLS_DIR)) { console.error(`no skills dir: ${SKILLS_DIR}`); process.exit(1); }
const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();

const skillNames = new Set(skillDirs);
const routesOut = new Map(skillDirs.map((s) => [s, new Set()]));
let sqlCount = 0, cypherCount = 0;
const queryReport = [];
const conventionBlocks = new Map(); // skill -> extracted output-conventions block (for the identity check)

for (const skill of skillDirs) {
  const file = join(SKILLS_DIR, skill, 'SKILL.md');
  if (!existsSync(file)) { err(skill, 'no SKILL.md'); continue; }
  // Normalize CRLF→LF: the \n-anchored frontmatter/SQL regexes below must not depend on the
  // checkout's line endings (Windows CI checks out CRLF by default). Belt to .gitattributes' braces.
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

  // 1. frontmatter
  const fm = parseFrontmatter(text);
  if (!fm) { err(skill, 'missing/malformed YAML frontmatter'); }
  else {
    if (!fm.name) err(skill, 'frontmatter missing `name`');
    else {
      if (fm.name !== skill) err(skill, `frontmatter name "${fm.name}" != folder "${skill}"`);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) err(skill, `name "${fm.name}" not kebab-case`);
      if (fm.name.length > 64) err(skill, `name ${fm.name.length} chars > 64`);
      if (/anthropic|claude/i.test(fm.name)) err(skill, `name contains reserved word (anthropic/claude)`);
    }
    if (!fm.description) err(skill, 'frontmatter missing `description`');
    else {
      if (fm.description.length > 1024) err(skill, `description ${fm.description.length} chars > 1024 (platform max)`);
      else if (fm.description.length > 200) warn(skill, `description ${fm.description.length} chars > 200 (claude.ai UI may truncate)`);
      // front-loading: the disambiguating trigger must land in the first ~200 chars (all the UI shows)
      const head = fm.description.slice(0, 200).toLowerCase();
      const phrases = TRIGGER_PHRASES[skill];
      if (!phrases) warn(skill, `no TRIGGER_PHRASES entry — add one so front-loading is enforced`);
      else if (!phrases.some((p) => head.includes(p.toLowerCase())))
        err(skill, `description first 200 chars lack a core trigger (one of: ${phrases.join(' | ')}) — front-load it`);
    }
  }

  // 1b. shared output-conventions block — must be present, and byte-identical across all skills
  {
    const s = text.indexOf(CONV_START);
    const e = text.indexOf(CONV_END);
    if (s === -1 || e === -1 || e < s) err(skill, `missing/malformed output-conventions block (${CONV_START} … ${CONV_END})`);
    else conventionBlocks.set(skill, text.slice(s, e + CONV_END.length));
  }

  // 2. tool-call param validation
  for (const tool of TOOL_NAMES) {
    const re = new RegExp(`\\b${tool}\\s*\\(\\s*\\{`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const open = text.indexOf('{', m.index);
      const body = balancedObject(text, open);
      if (body === null) continue; // unbalanced snippet, skip
      const keys = extractKeys(body);
      const spec = TOOLS[tool];
      for (const k of keys) {
        if (!spec.params.includes(k)) err(skill, `${tool}({ ${k} }) — unknown param "${k}"; valid: ${spec.params.join(', ') || '(none)'}`);
      }
      for (const group of (spec.requiredOneOf || [])) {
        if (!group.some((g) => keys.includes(g))) err(skill, `${tool}(...) — missing a required param (one of: ${group.join(' | ')})`);
      }
      for (const group of (spec.exactlyOneOf || [])) {
        const n = group.filter((g) => keys.includes(g)).length;
        if (n !== 1) err(skill, `${tool}(...) — needs EXACTLY one of: ${group.join(' | ')} (got ${n}; the tool errors on 0 or >1)`);
      }
    }
  }

  // 2b. unknown tool-shaped calls — a snake_case `name({ ... })` pattern whose name is NOT in the
  //     schema snapshot is probably a typo'd/renamed gateway tool the param check silently skips.
  //     WARNING (not error): the heuristic (contains `_`, appears with `({`) avoids most JS/SQL
  //     function false-positives, but can't rule them out entirely.
  {
    const seen = new Set();
    const unknownRe = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(\s*\{/g;
    let um;
    while ((um = unknownRe.exec(text))) {
      const name = um[1];
      if (!TOOLS[name] && !seen.has(name)) {
        seen.add(name);
        warn(skill, `${name}({ ... }) looks like a tool call but "${name}" is not in tool-schemas.json — typo, or snapshot needs a refresh? (params NOT validated)`);
      }
    }
  }

  // 3. routing edges — scoped to the "## Guardrails / routes out" section, so a prose mention
  //    elsewhere (e.g. a forward-note "coordinate tier labels with X") is NOT counted as a route.
  const gm = text.match(/##\s*Guardrails[\s\S]*?(?=\n##\s|$)/i);
  const routeRegion = gm ? gm[0] : text; // fall back to whole file if no Guardrails section
  for (const other of skillNames) {
    if (other !== skill && new RegExp(`\\b${other}\\b`).test(routeRegion)) routesOut.get(skill).add(other);
  }

  // 4. count embedded queries
  const sql = [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((x) => x[1]);
  const cyp = [...text.matchAll(/```cypher\n([\s\S]*?)```/g)].map((x) => x[1]);
  sqlCount += sql.length; cypherCount += cyp.length;
  if (listQueries) {
    sql.forEach((q, i) => queryReport.push(`  [${skill}] SQL #${i + 1}: ${q.trim().split('\n')[0].slice(0, 80)}…`));
    cyp.forEach((q, i) => queryReport.push(`  [${skill}] Cypher #${i + 1}: ${q.trim().split('\n')[0].slice(0, 80)}…`));
  }
}

// 3b. routing-graph connectivity — no orphans
const routedTo = new Set();
for (const [, outs] of routesOut) for (const o of outs) routedTo.add(o);
for (const skill of skillDirs) {
  if (routesOut.get(skill).size === 0) err(skill, 'routes to no sibling skill (dead-end)');
  if (!routedTo.has(skill)) err(skill, 'no sibling skill routes to it (orphan)');
}

// 1c. output-conventions blocks must all be byte-identical (no drift across the 6 copies).
//     Reference = the first skill (alphabetical) that has a block; every other must match it exactly.
{
  const present = [...conventionBlocks.entries()];
  if (present.length > 1) {
    const [refSkill, refBlock] = present[0];
    for (const [skill, block] of present.slice(1)) {
      if (block !== refBlock) err(skill, `output-conventions block differs from ${refSkill}'s — the 6 copies must be byte-identical (re-sync it)`);
    }
  }
}

// --- report ----------------------------------------------------------------

console.log(`verify-skills: ${skillDirs.length} skills · ${TOOL_NAMES.length} known tools · ${sqlCount} SQL + ${cypherCount} Cypher blocks`);
if (listQueries && queryReport.length) console.log('\nEmbedded queries (run live via the gateway to fully verify):\n' + queryReport.join('\n'));
if (warnings.length) console.log('\nWARNINGS:\n' + warnings.join('\n'));
if (errors.length) { console.log('\nERRORS:\n' + errors.join('\n')); console.log(`\n✗ FAIL — ${errors.length} error(s)`); process.exit(1); }
console.log(`\n✓ PASS — no errors${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
