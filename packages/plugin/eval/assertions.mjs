// assertions.mjs — pure, credential-free shape/grounding checks for a recorded skill trajectory.
//
// Tier-2 asserts SHAPE, not values (values drift with the data). Every check here is a regex/structural
// function over an answer string + a recorded tool trace — no model, no gateway — so the SCORER runs
// anywhere (incl. CI). Only *recording* a trajectory needs the Agent SDK + live gateway.
//
// A "record" is: { question, skill, trace: [{ tool, args?, error? }], answer }.
//
// Run `node assertions.mjs --self-test` to prove the assertions themselves (synthetic pass/fail cases).

export const VALID_FAMILIES = [
  'Birthday Party', 'Wedding and Engagement', 'Corporate', 'Festive Celebration',
  'Social Get Together', 'Personal Celebration', 'MICE and Launch Activation', 'Public and School Event'
];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MONEY_RE = /(?:AED\s*[\d,]+(?:\.\d+)?)|(?:[\d,]+(?:\.\d+)?\s*AED)/gi;
const LABEL_RE = /(cost|selling|sell|sale|delivery|estimate|estimated|list price|charge|charged|paid|per[-\s]?guest|per[-\s]?unit|indicative|anchor|median)/i;

const ok = (name, pass, detail = '') => ({ name, pass, detail });

// --- answer-only assertions -----------------------------------------------------------------------
export function hasIntegerCitation(answer) {
  // A #-prefixed key, OR "order/event/ticket [no.|number|#] <int>" with the number RIGHT AFTER the
  // keyword. The number must immediately follow (not up to N chars later) so a bare year near the word
  // — "the event was rescheduled to 2026" — does NOT count as a citation.
  const hashKey = /#\d{2,}/.test(answer);
  const prose = /\b(order|event|ticket)s?\b\s*(?:no\.?|number|#)?\s*#?\d{2,}/i.test(answer);
  const pass = hashKey || prose;
  return ok('hasIntegerCitation', pass, pass ? '' : 'no #<int> / "order|event|ticket <int>" citation found');
}

export function noUuid(answer) {
  const m = answer.match(UUID_RE);
  return ok('noUuid', !m, m ? `leaked UUID: ${m[0]}` : '');
}

export function moneyLabelled(answer) {
  const figures = [...answer.matchAll(MONEY_RE)];
  if (!figures.length) return ok('moneyLabelled', true, 'no money figures in answer');
  for (const f of figures) {
    const i = f.index;
    // Tight ±30-char window: a label attaches adjacently ("cost: X AED" / "X AED (selling)"); a wider
    // window would let one figure's label bleed onto an adjacent unlabelled figure.
    const window = answer.slice(Math.max(0, i - 30), i + f[0].length + 30);
    if (!LABEL_RE.test(window)) return ok('moneyLabelled', false, `unlabelled money figure: "${f[0].trim()}"`);
  }
  return ok('moneyLabelled', true, `${figures.length} figure(s), all labelled`);
}

export function freshnessShown(answer) {
  // Require a genuine data-freshness signal. A bare "window" is dropped — it false-passes on an event
  // date window ("event window opens 2026-09-15"), which is scheduling, not data freshness.
  const pass = /as[-\s]of/i.test(answer)
    || /freshness/i.test(answer)
    || /(corpus|mirror|data window|last sync(?:ed)?|synced)[^.\n]{0,30}\b20\d\d\b/i.test(answer);
  return ok('freshnessShown', pass, pass ? '' : 'no as-of / corpus / mirror freshness signal');
}

// Finding-8 regression: a known band outlier (e.g. White Chiavari max 1260) must not be quoted as a price.
export function noRawMaxQuoted(answer, forbiddenValues = []) {
  for (const v of forbiddenValues) {
    const n = String(v);
    const withComma = n.length > 3 ? n.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : n;
    const adjAed = new RegExp(`(?:AED\\s*(?:${n}|${withComma})\\b)|(?:\\b(?:${n}|${withComma})\\s*AED)`, 'i');
    // Also catch the bare number (AED may be established earlier in the paragraph: "a rare max around 1260").
    // Guarded to values >= 100 — a curated band-extreme is an outlier, unlikely to be a coincidental count;
    // small values (e.g. a 10 AED anchor) would false-fire, so they are only matched when AED-adjacent.
    const bare = v >= 100 ? new RegExp(`\\b(?:${n}|${withComma})\\b`) : null;
    if (adjAed.test(answer) || (bare && bare.test(answer)))
      return ok('noRawMaxQuoted', false, `quoted a forbidden band-extreme as a price: ${v}`);
  }
  return ok('noRawMaxQuoted', true, forbiddenValues.length ? `avoided ${forbiddenValues.join(', ')}` : 'no forbidden values configured');
}

// --- trace assertions -----------------------------------------------------------------------------
export function usedExpectedSkill(record, expectedSkill) {
  const pass = record.skill === expectedSkill;
  return ok('usedExpectedSkill', pass, pass ? '' : `invoked "${record.skill}", expected "${expectedSkill}"`);
}

export function usedExpectedTools(record, expectedTools = []) {
  const used = new Set((record.trace || []).map((t) => t.tool));
  const missing = expectedTools.filter((t) => !used.has(t));
  return ok('usedExpectedTools', missing.length === 0, missing.length ? `missing tool call(s): ${missing.join(', ')}` : '');
}

// Finding-1 regression: no event_playbook call with a bareword family (schema-valid, semantically wrong).
export function noFirstCallEnumError(record) {
  for (const t of record.trace || []) {
    if (t.tool !== 'event_playbook') continue;
    if (t.error && /family|no .* match/i.test(t.error)) return ok('noFirstCallEnumError', false, `event_playbook errored: ${t.error}`);
    const fam = t.args?.family;
    if (fam && !VALID_FAMILIES.includes(fam)) return ok('noFirstCallEnumError', false, `event_playbook family="${fam}" is not one of the 8 valid enums`);
  }
  return ok('noFirstCallEnumError', true, '');
}

// --- dispatcher: run a named assertion against a record + its golden case ---------------------------
export function runAssertion(name, record, goldenCase) {
  switch (name) {
    case 'hasIntegerCitation': return hasIntegerCitation(record.answer);
    case 'noUuid':             return noUuid(record.answer);
    case 'moneyLabelled':      return moneyLabelled(record.answer);
    case 'freshnessShown':     return freshnessShown(record.answer);
    case 'noRawMaxQuoted':     return noRawMaxQuoted(record.answer, goldenCase.forbiddenValues || []);
    case 'usedExpectedSkill':  return usedExpectedSkill(record, goldenCase.expectedSkill);
    case 'usedExpectedTools':  return usedExpectedTools(record, goldenCase.expectedTools || []);
    case 'noFirstCallEnumError': return noFirstCallEnumError(record);
    default: return ok(name, false, `unknown assertion "${name}"`);
  }
}

export const ASSERTION_NAMES = [
  'hasIntegerCitation', 'noUuid', 'moneyLabelled', 'freshnessShown',
  'noRawMaxQuoted', 'usedExpectedSkill', 'usedExpectedTools', 'noFirstCallEnumError'
];

// --- self-test (credential-free proof the assertions behave) ---------------------------------------
function selfTest() {
  const fails = [];
  let total = 0;
  const expect = (label, cond) => { total++; if (!cond) fails.push(label); };

  expect('hasIntegerCitation +', hasIntegerCitation('see order #16504').pass);
  expect('hasIntegerCitation +prose', hasIntegerCitation('cited by event 4821 above').pass);
  expect('hasIntegerCitation -', !hasIntegerCitation('no numbers with a hash here').pass);
  expect('hasIntegerCitation -year', !hasIntegerCitation('The event was rescheduled to 2026 due to weather.').pass);

  expect('noUuid +', noUuid('partner Al Jefoon, order #123').pass);
  expect('noUuid -', !noUuid('id 6a86604d-7c5a-4852-8444-1e4b063f49c3').pass);

  expect('moneyLabelled +', moneyLabelled('10 AED (supplier cost, ORDER tier)').pass);
  expect('moneyLabelled +none', moneyLabelled('no prices here').pass);
  expect('moneyLabelled -', !moneyLabelled('it was 1,250 AED for the lot, delivered next week and set up nicely with extra flourish and decorative touches all around the hall').pass);
  expect('moneyLabelled -bleed', !moneyLabelled(`the cost was 100 AED ${'x'.repeat(20)} 5000 AED for something else entirely`).pass);

  expect('freshnessShown +asof', freshnessShown('WA corpus as-of 2026-09-03').pass);
  expect('freshnessShown +mirror', freshnessShown('haflaCore mirror last synced 2026-09-03').pass);
  expect('freshnessShown -', !freshnessShown('here are the results').pass);
  expect('freshnessShown -eventwindow', !freshnessShown('Your event window opens on 2026-09-15 and closes shortly after.').pass);

  expect('noRawMaxQuoted +', noRawMaxQuoted('anchor 10 AED, band 8-10 AED', [1260]).pass);
  expect('noRawMaxQuoted -plain', !noRawMaxQuoted('up to 1260 AED', [1260]).pass);
  expect('noRawMaxQuoted -comma', !noRawMaxQuoted('up to AED 1,260', [1260]).pass);
  expect('noRawMaxQuoted -bareNoAed', !noRawMaxQuoted('the max was around 1260, an outlier', [1260]).pass);
  expect('noRawMaxQuoted +smallBareSafe', noRawMaxQuoted('we had 10 chairs', [10]).pass);

  expect('usedExpectedSkill +', usedExpectedSkill({ skill: 'pricing-lookup' }, 'pricing-lookup').pass);
  expect('usedExpectedSkill -', !usedExpectedSkill({ skill: 'supplier-discovery' }, 'pricing-lookup').pass);

  expect('usedExpectedTools +', usedExpectedTools({ trace: [{ tool: 'price_anchor' }] }, ['price_anchor']).pass);
  expect('usedExpectedTools -', !usedExpectedTools({ trace: [{ tool: 'catalog_search' }] }, ['price_anchor']).pass);

  expect('noFirstCallEnumError +good', noFirstCallEnumError({ trace: [{ tool: 'event_playbook', args: { family: 'Wedding and Engagement' } }] }).pass);
  expect('noFirstCallEnumError -bareword', !noFirstCallEnumError({ trace: [{ tool: 'event_playbook', args: { family: 'Wedding' } }] }).pass);
  expect('noFirstCallEnumError -errored', !noFirstCallEnumError({ trace: [{ tool: 'event_playbook', error: 'No family matches "Wedding"' }] }).pass);

  if (fails.length) {
    console.log(`✗ assertions self-test FAILED (${fails.length}):`);
    for (const f of fails) console.log(`   - ${f}`);
    process.exit(1);
  }
  console.log(`✓ assertions self-test PASS — all ${total} synthetic pass/fail cases behave.`);
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--self-test')) selfTest();
