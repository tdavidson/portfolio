// The lp-quarterly-letter skill, as the app holds it: one source for the fund's own letter writer
// and for any assistant connected over MCP (lp_letter_skill), so both write to the same structure.
//
// The skill lives in plugin/skills/lp-quarterly-letter/ and reaches the server bundled as strings
// (lib/plugin/plugin-files.generated.ts, `npm run mcp:app`), the same way the plugin download does.
//
// SKILL.md is the process and the structure, and it is the same for every fund. The voice is not:
// references/voice.md and references/examples.md in the repo are a general voice, and a fund that has
// saved its own (its default letter template's style guide) uses that instead. A fund's own voice is
// its data, kept in its database, never in this public repository.
//
// Pure: no server imports.

import { PLUGIN_FILES } from '@/lib/plugin/plugin-files.generated'
import { DEFAULT_STYLE_GUIDE } from './default-template'

const DIR = 'skills/lp-quarterly-letter'

function file(name: string): string {
  const text = PLUGIN_FILES[`${DIR}/${name}`]
  if (typeof text !== 'string') throw new Error(`The lp-quarterly-letter skill is missing ${name}. Run npm run mcp:app.`)
  return text
}

export const LETTER_SKILL_MD = file('SKILL.md')
export const DEFAULT_VOICE_MD = file('references/voice.md')
export const DEFAULT_EXAMPLES_MD = file('references/examples.md')

/** The skill's version, from its frontmatter (`metadata.version`). Stored on each letter written with it. */
export const LETTER_SKILL_VERSION: string = (() => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(LETTER_SKILL_MD)?.[1] ?? ''
  return /^\s+version:\s*"?([^"\n]+)"?\s*$/m.exec(front)?.[1]?.trim() ?? 'unversioned'
})()

/** The skill's body, without its frontmatter. */
export function skillBody(md: string = LETTER_SKILL_MD): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

/** The `## ` sections of a markdown document, by heading. */
export function sectionsOf(md: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = skillBody(md).split(/^(?=## )/m)
  for (const part of parts) {
    const m = /^## (.+)\n/.exec(part)
    if (m) out.set(m[1].trim(), part.trim())
  }
  return out
}

/**
 * The parts of the skill a writer working from a brief needs. The rest of SKILL.md (inputs, the
 * tool-by-tool workflow, the output document) is for an assistant driving the app over MCP; the
 * app's own writer is handed the brief instead.
 */
export const WRITER_SECTIONS = [
  'Fund profile', 'Keeping funds separate', 'Structure', 'Sizing each company section', 'Voice', 'Review checklist',
] as const

export function skillForWriter(md: string = LETTER_SKILL_MD): string {
  const sections = sectionsOf(md)
  const missing = WRITER_SECTIONS.filter(s => !sections.has(s))
  if (missing.length) throw new Error(`The lp-quarterly-letter skill has no section ${missing.map(s => `"${s}"`).join(', ')}.`)
  return WRITER_SECTIONS.map(s => sections.get(s)!).join('\n\n')
}

export interface LetterVoice {
  /** `fund`: the fund's own, saved as its default letter template. `default`: the skill's general voice. */
  source: 'fund' | 'default'
  /** The template it came from, when it is the fund's. */
  template: string | null
  voice: string
  /** The examples: the fund's own (learned from its letters), the general ones, or empty. */
  examples: string
  /** The fund's house rules: standing instructions added to every letter. Empty when it has none. */
  houseRules: string
  /** The fund's own letter structure, which replaces the skill's general outline. Empty when it has none. */
  structure: string
}

export interface VoiceTemplate {
  name: string
  styleGuide: string | null
  examples?: string | null
  houseRules?: string | null
  structure?: string | null
}

/**
 * The voice a letter is written in. A fund's saved style guide replaces the skill's general voice
 * and examples (with its own examples, when it has them), except the built-in "Default" style
 * guide, which older funds saved as a row and which the skill now supersedes. The structure and
 * house rules are the template's either way: they apply with whichever voice does.
 */
export function letterVoice(template: VoiceTemplate | null): LetterVoice {
  const guide = template?.styleGuide?.trim() ?? ''
  const houseRules = template?.houseRules?.trim() ?? ''
  const structure = template?.structure?.trim() ?? ''
  if (guide && guide !== DEFAULT_STYLE_GUIDE.trim()) {
    return { source: 'fund', template: template!.name, voice: guide, examples: template?.examples?.trim() ?? '', houseRules, structure }
  }
  return {
    source: 'default', template: houseRules || structure ? template!.name : null,
    voice: DEFAULT_VOICE_MD.trim(), examples: DEFAULT_EXAMPLES_MD.trim(), houseRules, structure,
  }
}

/**
 * The voice as one style guide, for the per-company writer, which takes a single text. The general
 * examples stay out: that writer is called once per company, and they would only add length.
 */
export function voiceAsStyleGuide(v: LetterVoice): string {
  return [
    ...(v.structure ? ["THE FUND'S LETTER STRUCTURE (write each company section as it lays them out)", v.structure, '', 'VOICE'] : []),
    v.voice,
    ...(v.source === 'fund' && v.examples ? ['', 'EXAMPLES (invented companies and figures: match the shape, never take facts from them)', v.examples] : []),
    ...(v.houseRules ? ['', "HOUSE RULES (the fund's own; follow them over the voice and examples)", v.houseRules] : []),
  ].join('\n')
}
