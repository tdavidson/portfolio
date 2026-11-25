/**
 * Run the letter and memo skills on the invented cases in evals/ and grade what they write.
 *
 *   npm run evals                                         # every case of both skills, once
 *   npm run evals -- --skill investment-memo --runs 3     # one skill, three runs per case
 *   npm run evals -- --case mixed-quarter                 # one case
 *   npm run evals -- --model claude-opus-4-8              # the model to run (default: the strong tier)
 *   npm run evals -- --provider openai --model gpt-4.1    # another provider (anthropic or openai)
 *   npm run evals -- --skill lp-quarterly-letter --case mixed-quarter --grade letter.txt
 *                                                         # grade text written elsewhere, no model call
 *
 * The key is EVAL_API_KEY, or ANTHROPIC_API_KEY / OPENAI_API_KEY for the provider. Each reply and a
 * summary.json are written to evals/results/<time>/ (gitignored). Exits non-zero when a case fails.
 * The grading needs no key and runs in CI (lib/skill-evals/cases.test.ts); this script is for
 * checking a change to a skill, or a new model, before it ships.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createProviderFromKey, type ProviderType } from '@/lib/ai'
import { modelForTier } from '@/lib/ai/recommended'
import { EVAL_SKILLS, evalPrompt, evalsDir, grade, listCases, type EvalSkill } from '@/lib/skill-evals/cases'
import type { EvalResult } from '@/lib/skill-evals/types'

const args = process.argv.slice(2)
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

const MAX_TOKENS: Record<EvalSkill, number> = { 'lp-quarterly-letter': 20000, 'investment-memo': 16000 }

function fail(message: string): never {
  console.error(`evals: ${message}`)
  process.exit(2)
}

async function main() {
  const skillArg = opt('--skill')
  if (skillArg && !EVAL_SKILLS.includes(skillArg as EvalSkill)) fail(`no evals for "${skillArg}". Known: ${EVAL_SKILLS.join(', ')}.`)
  const skills = skillArg ? [skillArg as EvalSkill] : [...EVAL_SKILLS]
  const caseId = opt('--case')
  const plan = skills.flatMap(skill => listCases(skill).filter(c => !caseId || c.id === caseId).map(c => ({ skill, c })))
  if (!plan.length) fail(caseId ? `no case "${caseId}".` : 'no cases.')

  const gradeFile = opt('--grade')
  if (gradeFile) {
    if (plan.length !== 1) fail('--grade needs one case: pass --skill and --case.')
    const r = grade(plan[0].skill, fs.readFileSync(path.resolve(gradeFile), 'utf8'), plan[0].c)
    report([r])
    process.exit(r.pass ? 0 : 1)
  }

  const provider = (opt('--provider') ?? 'anthropic') as ProviderType
  if (provider !== 'anthropic' && provider !== 'openai') fail('--provider is anthropic or openai.')
  const key = process.env.EVAL_API_KEY ?? (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY)
  if (!key) fail(`set EVAL_API_KEY (or ${provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}) to run the skills, or pass --grade to grade a saved reply.`)
  const model = opt('--model') ?? (modelForTier('strong', provider, '') || fail('pass --model.'))
  const runs = Math.max(1, Number(opt('--runs') ?? 1))
  const ai = createProviderFromKey(key, provider)

  const out = path.join(evalsDir, 'results', new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(out, { recursive: true })
  console.log(`Running ${plan.length} case${plan.length === 1 ? '' : 's'} × ${runs} on ${model}. Replies go to ${path.relative(process.cwd(), out)}.\n`)

  const results: Array<EvalResult & { run: number }> = []
  for (const { skill, c } of plan) {
    const { system, user } = evalPrompt(skill, c)
    for (let run = 1; run <= runs; run++) {
      let text: string
      try {
        const reply = await ai.createMessage({ model, maxTokens: MAX_TOKENS[skill], system, content: user })
        text = reply.text
        if (reply.truncated) console.warn(`  ${c.id} run ${run}: the reply was cut off at ${MAX_TOKENS[skill]} tokens.`)
      } catch (e) {
        results.push({ case: c.id, skill, run, pass: false, failures: [{ check: 'model_call', message: (e as Error).message }], tolerated: [] })
        continue
      }
      fs.writeFileSync(path.join(out, `${skill}--${c.id}--${run}.${skill === 'investment-memo' ? 'json' : 'txt'}`), text)
      results.push({ ...grade(skill, text, c), run })
    }
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ model, provider, runs, results }, null, 2))
  report(results)
  process.exit(results.every(r => r.pass) ? 0 : 1)
}

function report(results: Array<EvalResult & { run?: number }>) {
  for (const r of results) {
    console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.skill} / ${r.case}${r.run ? ` (run ${r.run})` : ''}`)
    for (const f of r.failures) console.log(`        ✗ ${f.check}: ${f.message}`)
    for (const f of r.tolerated) console.log(`        ~ ${f.check}: ${f.message}`)
  }
  const passed = results.filter(r => r.pass).length
  console.log(`\n${passed} of ${results.length} passed.`)
}

main().catch(e => fail((e as Error).stack ?? String(e)))
