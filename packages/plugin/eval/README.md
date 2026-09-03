# EvWA skills — answer-quality eval

The static harness (`../scripts/verify-skills.mjs`) proves a skill is *well-formed* — params exist,
frontmatter is legal, the routing graph is connected, the output-conventions block hasn't drifted. It
says nothing about whether an answer is *right*. These evals cover the behaviour static analysis can't:

**Why static is not enough — the class that shipped.** `event_playbook({ family: "Wedding" })` is a
legal param with a legal string type: every static gate passes. It fails live because `family` has a
*value-level* contract (8 exact enum strings). Same shape: `supplier_discovery({ product: "AUS event" })`
returns a confident empty; a description that quietly grabs the wrong question. No param-name check sees
these — only routing/trajectory evals do.

## Tiers

| Tier | What it checks | Cost | Where | Status |
| ---- | -------------- | ---- | ----- | ------ |
| **1 — routing** | Given only the 6 descriptions, does a question hit the right skill? | ~cheap single calls | `run-routing-eval.mjs` + `golden-routing.json` | **built** (seed set) |
| **2 — sampled trajectory** | 15–20 stratified questions run through the skills + live gateway; assert shape/grounding (right skill, right tools, ≥1 integer citation, no UUID, money labelled, freshness shown, no first-call enum error, no raw `max` quoted) | moderate | (Batch 2) | planned |
| **3 — full answer-quality grading** | LLM-judge scoring of the whole ~106-question set | high | (deferred) | on trigger only |

Tier 1 is the safety net for the frontmatter **descriptions** — the one thing no other check covers, and
the exact place the >200-char truncation / front-loading tension lives. It is the regression guard for
ever shortening or re-wording a description.

## Running Tier 1

```bash
# structural check — credential-free, safe anywhere (CI could run this half if desired):
node run-routing-eval.mjs --check

# the real eval — needs a key; NOT in CI (costs tokens, needs a credential):
ANTHROPIC_API_KEY=sk-... node run-routing-eval.mjs [--verbose]
```

The runner gives a model **only** the 6 `name: description` pairs and asks which single skill each
golden question should trigger, then scores against `golden-routing.json` (threshold ≥95%). A miss is
either a **description bug** or a **golden-label bug** — investigate both. `EVAL_MODEL` overrides the
default (`claude-haiku-4-5-20251001`).

## The golden set

`golden-routing.json` is a **seed** (~25 cases), weighted toward real `#ask-evwa` demand and covering all
6 skills. Three cases are tagged `"negative": true` — the hiccups-hunt collisions where a sibling skill
plausibly grabs the question but must not ("what does a wedding cost" → event-needs, not pricing-lookup;
"who did the AUS event" → past-orders, not supplier-discovery). Two are `out-of-scope` (margin /
pricing-strategy). The full target is the ~106 `#ask-evwa` questions (taxonomy in the private
`mcp-gateway/.../2026-05-23-evwa-v0-analysis.md`); ~60–70 are recoverable by re-extraction — a Batch-2
first task.

**Adding cases:** append to `cases[]` with `question` + `expectedSkill` (a folder name or
`out-of-scope`). Re-run `--check` — it enforces valid targets, no duplicate questions, and ≥1 case per
skill.

> This eval already earned its keep: routing the seed set flagged that `supplier-discovery`'s description
> never mentioned its single-partner *dossier* capability, so "dossier on supplier X" was ambiguous
> against `past-orders`. The description was fixed before the set shipped.
