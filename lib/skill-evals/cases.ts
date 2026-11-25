// Loading the eval cases and building the prompt a skill runs with in an eval: the skill's own
// SKILL.md and references as the system prompt, and the case's brief as the tool result the skill
// would have fetched. Node-only (reads the repo); used by scripts/skill-evals.ts and the tests.

import fs from 'node:fs'
import path from 'node:path'
import { gradeLetter, type LetterCase } from './letter'
import { gradeMemo, type MemoCase } from './memo'
import type { EvalResult } from './types'

export const EVAL_SKILLS = ['lp-quarterly-letter', 'investment-memo'] as const
export type EvalSkill = (typeof EVAL_SKILLS)[number]

const root = path.resolve(__dirname, '..', '..')
export const evalsDir = path.join(root, 'evals')

/** The case files for a skill: evals/<skill>/<id>.json (golden outputs sit beside them). */
export function listCases(skill: EvalSkill): Array<LetterCase | MemoCase> {
  const dir = path.join(evalsDir, skill)
  return fs.readdirSync(dir)
    .filter(f => /^[a-z0-9-]+\.json$/.test(f))
    .sort()
    .map(f => {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (c.id !== f.replace(/\.json$/, '')) throw new Error(`evals/${skill}/${f}: its id is "${c.id}"; it should match the file name.`)
      return c
    })
}

/** A golden output beside a case (`<id>.good.txt`, `<id>.bad.json`), or null when there is none. */
export function golden(skill: EvalSkill, id: string, kind: 'good' | 'bad'): string | null {
  const ext = skill === 'investment-memo' ? 'json' : 'txt'
  const file = path.join(evalsDir, skill, `${id}.${kind}.${ext}`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

export function grade(skill: EvalSkill, output: string, c: LetterCase | MemoCase): EvalResult {
  return skill === 'investment-memo' ? gradeMemo(output, c as MemoCase) : gradeLetter(output, c as LetterCase)
}

/** The skill as an assistant loads it: SKILL.md, then each reference file. */
export function skillText(skill: EvalSkill): string {
  const dir = path.join(root, 'plugin', 'skills', skill)
  const parts = [fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')]
  const refs = path.join(dir, 'references')
  if (fs.existsSync(refs)) {
    for (const f of fs.readdirSync(refs).filter(f => f.endsWith('.md')).sort()) {
      parts.push(`# references/${f}\n\n${fs.readFileSync(path.join(refs, f), 'utf8')}`)
    }
  }
  return parts.join('\n\n---\n\n')
}

const HARNESS: Record<EvalSkill, (c: any) => string> = {
  'lp-quarterly-letter': (c: LetterCase) => [
    'This is an evaluation run of the skill above. There are no tools in this run: the calls the workflow makes have already been made for you.',
    `- list_funds and use_fund: the active fund is ${c.brief.fund}.`,
    '- lp_letter_skill: the fund has saved no template, so use the general structure, voice and examples above.',
    '- lp_letters: there is no earlier final letter for this entity.',
    '- The partners have answered; their notes are in the brief as partner_notes. No one is available for further questions.',
    '',
    'Here is what lp_letter_brief returned:',
    '',
    JSON.stringify(c.brief, null, 2),
    '',
    "Reply with Hemrock's copy of the letter only: exactly the text you would pass to lp_draft_letter as `text`, ending with the \"Missing information\" section. No preamble and no report back.",
  ].join('\n'),
  'investment-memo': (c: MemoCase) => [
    'This is an evaluation run of the skill above. There are no tools in this run: the calls the workflow makes have already been made for you.',
    `- list_funds, use_fund and diligence_list_deals: the deal is ${c.brief.deal.name}.`,
    '- diligence_memo_skill: the fund has saved no template, so use the section list in the brief and the general voice and examples above.',
    '- The partners have been asked; any notes are in the brief. No one is available for further questions, and there is no research tool.',
    '',
    'Here is what diligence_memo_brief returned:',
    '',
    JSON.stringify(c.brief, null, 2),
    '',
    'Reply with only the JSON you would pass to diligence_draft_memo: {"paragraphs": [{"section", "text", "sources": [refs]}], "attention": [{"body", "urgency", "sources"}]}. No preamble.',
  ].join('\n'),
}

export function evalPrompt(skill: EvalSkill, c: LetterCase | MemoCase): { system: string; user: string } {
  return { system: skillText(skill), user: HARNESS[skill](c) }
}
