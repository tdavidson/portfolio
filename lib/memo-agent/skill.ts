// The investment-memo skill, as the app holds it: one source for the memo agent's own draft stage and
// for any assistant connected over MCP (diligence_memo_skill), so both write to the same rules.
//
// The skill lives in plugin/skills/investment-memo/ and reaches the server bundled as strings
// (lib/plugin/plugin-files.generated.ts, `npm run mcp:app`), as the LP letter skill does.
//
// SKILL.md is the process and the rules, the same for every fund. The voice is not: the repo's
// references/voice.md and examples.md are general, and a fund that has saved its own memo voice
// (diligence_memo_voice) uses that instead. A fund's voice is its data, kept in its database, never in
// this public repository.
//
// Pure: no server imports.

import { PLUGIN_FILES } from '@/lib/plugin/plugin-files.generated'

const DIR = 'skills/investment-memo'

function file(name: string): string {
  const text = PLUGIN_FILES[`${DIR}/${name}`]
  if (typeof text !== 'string') throw new Error(`The investment-memo skill is missing ${name}. Run npm run mcp:app.`)
  return text
}

export const MEMO_SKILL_MD = file('SKILL.md')
export const DEFAULT_MEMO_VOICE_MD = file('references/voice.md')
export const DEFAULT_MEMO_EXAMPLES_MD = file('references/examples.md')

/** The skill's version, from its frontmatter (`metadata.version`). Stored on each memo written with it. */
export const MEMO_SKILL_VERSION: string = (() => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(MEMO_SKILL_MD)?.[1] ?? ''
  return /^\s+version:\s*"?([^"\n]+)"?\s*$/m.exec(front)?.[1]?.trim() ?? 'unversioned'
})()

export function memoSkillBody(md: string = MEMO_SKILL_MD): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

/** The `## ` sections of the skill, by heading. */
export function memoSkillSections(md: string = MEMO_SKILL_MD): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of memoSkillBody(md).split(/^(?=## )/m)) {
    const m = /^## (.+)\n/.exec(part)
    if (m) out.set(m[1].trim(), part.trim())
  }
  return out
}

/** The parts a writer working from a brief needs (the rest drives the app over MCP). */
export const MEMO_WRITER_SECTIONS = ['Hard rules', 'Sizing each section', 'Citations', 'Review checklist'] as const

export function memoSkillForWriter(md: string = MEMO_SKILL_MD): string {
  const sections = memoSkillSections(md)
  const missing = MEMO_WRITER_SECTIONS.filter(s => !sections.has(s))
  if (missing.length) throw new Error(`The investment-memo skill has no section ${missing.map(s => `"${s}"`).join(', ')}.`)
  return MEMO_WRITER_SECTIONS.map(s => sections.get(s)!).join('\n\n')
}

/** A fund's saved memo voice (diligence_memo_voice), as stored. */
export interface MemoVoiceRow {
  voice: string | null
  house_rules: string | null
  examples: string | null
  learned_from?: string[] | null
  learned_at?: string | null
  updated_at?: string | null
}

export interface MemoVoice {
  /** `fund`: the fund's own. `default`: the skill's general voice. */
  source: 'fund' | 'default'
  voice: string
  examples: string
  /** The fund's standing instructions for every memo. Empty when it has none. */
  houseRules: string
}

export function memoVoice(row: MemoVoiceRow | null): MemoVoice {
  const voice = row?.voice?.trim() ?? ''
  const houseRules = row?.house_rules?.trim() ?? ''
  if (voice) return { source: 'fund', voice, examples: row?.examples?.trim() ?? '', houseRules }
  return { source: 'default', voice: DEFAULT_MEMO_VOICE_MD.trim(), examples: DEFAULT_MEMO_EXAMPLES_MD.trim(), houseRules }
}

/** The voice as one prompt block for the app's own draft stage. */
export function memoVoiceBlock(v: MemoVoice): string {
  if (v.source === 'default' && !v.houseRules) return ''
  return [
    ...(v.source === 'fund'
      ? ["=== THE FUND'S MEMO VOICE (learned from its own memos and edited by the partners; write in it) ===", v.voice]
      : []),
    ...(v.source === 'fund' && v.examples
      ? ['', '=== EXAMPLES (invented companies and figures: match the shape, never take facts from them) ===', v.examples]
      : []),
    ...(v.houseRules ? ['', "=== HOUSE RULES (the fund's own; follow them over the voice and examples, never over the hard rules) ===", v.houseRules] : []),
  ].join('\n')
}
