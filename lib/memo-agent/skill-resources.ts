// The investment-memo skill as MCP resources on the GP connection, so a Claude client can read the
// current skill without syncing a copy. These are the files as the repo holds them, with the general
// voice; a fund's own voice is fund data, returned by the diligence_memo_skill tool.

import { DEFAULT_MEMO_EXAMPLES_MD, DEFAULT_MEMO_VOICE_MD, MEMO_SKILL_MD, MEMO_SKILL_VERSION } from './skill'

const BASE = 'skill://investment-memo/'

const FILES: { path: string; title: string; description: string; text: string }[] = [
  {
    path: 'SKILL.md', title: 'Investment memo skill', text: MEMO_SKILL_MD,
    description: `How to write a deal's investment memo: process, hard rules, citations and review checklist (version ${MEMO_SKILL_VERSION}). ` +
      "Call diligence_memo_skill for the same files with this fund's own voice, sections and design.",
  },
  { path: 'references/voice.md', title: 'Memo voice (general)', text: DEFAULT_MEMO_VOICE_MD, description: 'The general voice for investment memos.' },
  { path: 'references/examples.md', title: 'Memo examples', text: DEFAULT_MEMO_EXAMPLES_MD, description: 'Memo sections in full, with invented companies and figures.' },
]

export function listMemoSkillResources() {
  return FILES.map(f => ({ uri: BASE + f.path, name: `investment-memo/${f.path}`, title: f.title, description: f.description, mimeType: 'text/markdown' }))
}

export function readMemoSkillResource(uri: unknown) {
  if (typeof uri !== 'string' || !uri.startsWith(BASE)) return null
  const f = FILES.find(x => BASE + x.path === uri)
  return f ? { contents: [{ uri, mimeType: 'text/markdown', text: f.text }] } : null
}
