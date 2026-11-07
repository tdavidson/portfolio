// Investment memos work the same in the app and in a chat: every memo action on the Diligence pages
// has an MCP tool, and every memo tool does something the pages do. A new feature added on one side
// only fails here until the other side has it (or it is listed below as deliberately one-sided).

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_TOOLS } from '@/lib/accounting/agent-tools'
import { MEMO_TOOL_MANIFEST } from '@/lib/agent/memo-tools-manifest'

/** In the app (an API route and method) → over MCP (a tool). */
const PARITY: Array<{ action: string; route: string; method: string; tool: string }> = [
  { action: 'Read the memo skill, voice and sections', route: 'api/firm/memo-voice', method: 'GET', tool: 'diligence_memo_skill' },
  { action: 'Read the memo voice', route: 'api/firm/memo-voice', method: 'GET', tool: 'diligence_memo_voice' },
  { action: 'Learn the memo voice from sample memos', route: 'api/firm/memo-voice', method: 'POST', tool: 'diligence_memo_voice_learn' },
  { action: 'Save the memo voice', route: 'api/firm/memo-voice', method: 'PUT', tool: 'diligence_memo_voice_save' },
  { action: 'Upload a sample memo', route: 'api/firm/style-anchors', method: 'POST', tool: 'diligence_add_sample_memo' },
  { action: 'Read the design template', route: 'api/diligence/memo-design', method: 'GET', tool: 'diligence_memo_settings' },
  { action: 'Pick the design template and first-page exemplar', route: 'api/diligence/prompts', method: 'PATCH', tool: 'diligence_memo_settings_save' },
  { action: "Set a deal's sections, guidance and persona", route: 'api/diligence/[id]/memo-config', method: 'PATCH', tool: 'diligence_memo_settings_save' },
  { action: 'Edit a memo schema', route: 'api/firm/schemas/[name]', method: 'PUT', tool: 'diligence_memo_settings_save' },
  { action: 'Run a memo agent stage', route: 'api/diligence/[id]/agent/draft', method: 'POST', tool: 'diligence_run_agent' },
  { action: 'Read the memo draft', route: 'api/diligence/[id]/drafts/[draftId]', method: 'GET', tool: 'diligence_memo' },
  { action: 'Edit a paragraph', route: 'api/diligence/[id]/drafts/[draftId]', method: 'PATCH', tool: 'diligence_write_memo' },
  { action: 'Finalize the memo', route: 'api/diligence/[id]/drafts/[draftId]/finalize', method: 'POST', tool: 'diligence_finalize_memo' },
  { action: 'Export Word, Google Doc, PDF or Markdown', route: 'api/diligence/[id]/agent/render', method: 'POST', tool: 'diligence_memo_export' },
  { action: 'Re-import an edited Word memo', route: 'api/diligence/[id]/drafts/import', method: 'POST', tool: 'diligence_import_memo' },
  { action: 'Resolve an attention item', route: 'api/diligence/[id]/attention/[itemId]', method: 'PATCH', tool: 'diligence_resolve_attention' },
  { action: 'List the diligence rounds', route: 'api/diligence/[id]/rounds', method: 'GET', tool: 'diligence_rounds' },
  { action: "Read a round: what changed, what was asked for, the request list", route: 'api/diligence/[id]/rounds/[roundId]', method: 'GET', tool: 'diligence_rounds' },
  { action: 'Start the next diligence round', route: 'api/diligence/[id]/rounds', method: 'POST', tool: 'diligence_round_save' },
  { action: 'Close, reopen or rename a round', route: 'api/diligence/[id]/rounds/[roundId]', method: 'PATCH', tool: 'diligence_round_save' },
]

/**
 * Tools whose app side is not one route, with where a partner does the same thing. A chat writes its
 * own memo from the brief; in the app the memo agent writes it from the same evidence, voice, sections
 * and review (stages/draft.ts), and the brief's contents are the deal page's tabs.
 */
const CHAT_SIDE: Record<string, string> = {
  diligence_memo_brief: 'the deal page: data room evidence, research, Q&A, notes and checklist tabs',
  diligence_draft_memo: 'the memo agent draft stage (same voice, sections and review flags)',
  diligence_add_research: 'the research stage and the Specter profile save into the data room',
}

const routeFile = (route: string) => path.join(process.cwd(), 'app', route, 'route.ts')

describe('investment memo parity between the app and MCP', () => {
  const tools = new Set(AGENT_TOOLS.map(t => t.name))

  it('every app memo action has its tool', () => {
    for (const p of PARITY) expect(tools.has(p.tool), `${p.action}: ${p.tool}`).toBe(true)
  })

  it('every app memo action is a real route with that method', () => {
    for (const p of PARITY) {
      const file = routeFile(p.route)
      expect(fs.existsSync(file), `${p.action}: ${p.route}`).toBe(true)
      expect(fs.readFileSync(file, 'utf8'), `${p.action}: ${p.method} ${p.route}`).toMatch(new RegExp(`export (async )?function ${p.method}\\b|export const ${p.method}\\b`))
    }
  })

  it('every memo tool is matched to something the app does', () => {
    const covered = new Set([...PARITY.map(p => p.tool), ...Object.keys(CHAT_SIDE)])
    for (const t of MEMO_TOOL_MANIFEST) expect(covered.has(t.name), t.name).toBe(true)
  })
})
