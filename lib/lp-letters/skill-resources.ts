// The lp-quarterly-letter skill as MCP resources on the GP connection, so a Claude client can read
// the current skill without syncing a copy. These are the files as the repo holds them, with the
// general voice; a fund's own voice is fund data, returned by the lp_letter_skill tool, which knows
// whose connection it is. The LP portal's connection does not list them.

import { DEFAULT_EXAMPLES_MD, DEFAULT_VOICE_MD, LETTER_SKILL_MD, LETTER_SKILL_VERSION } from './skill'

const BASE = 'skill://lp-quarterly-letter/'

const FILES: { path: string; title: string; description: string; text: string }[] = [
  {
    path: 'SKILL.md', title: 'LP quarterly letter skill', text: LETTER_SKILL_MD,
    description: `How to write a fund's quarterly investor letter: structure, sizing, voice rules and review checklist (version ${LETTER_SKILL_VERSION}). ` +
      'Call lp_letter_skill for the same files with this fund\'s own voice where it has one.',
  },
  { path: 'references/voice.md', title: 'LP letter voice (general)', text: DEFAULT_VOICE_MD, description: 'The general voice for LP letters.' },
  { path: 'references/examples.md', title: 'LP letter examples', text: DEFAULT_EXAMPLES_MD, description: 'Each letter section in full, with invented companies and figures.' },
]

export function listSkillResources() {
  return FILES.map(f => ({ uri: BASE + f.path, name: `lp-quarterly-letter/${f.path}`, title: f.title, description: f.description, mimeType: 'text/markdown' }))
}

export function readSkillResource(uri: unknown) {
  if (typeof uri !== 'string' || !uri.startsWith(BASE)) return null
  const f = FILES.find(x => BASE + x.path === uri)
  return f ? { contents: [{ uri, mimeType: 'text/markdown', text: f.text }] } : null
}
