import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider, McpServerConfig, ToolLoopResult } from '@/lib/ai/types'
import { withTopicalGuardrail } from '@/lib/ai/topical-guard'

/**
 * A Specter company profile, saved into a deal's data room as a Markdown document.
 *
 * Claude compiles it from Specter's read-only tools (through Anthropic's MCP connector, with the
 * asking member's own sign-in) rather than the app calling named Specter tools itself: the app
 * only knows which tools are read-only, not what each returns, and Specter can rename or add tools
 * without breaking this. Once saved, the document is ingested like any upload, so the memo agent
 * and the diligence assistant read it as evidence.
 */

export const NOT_FOUND_PREFIX = 'NOT_FOUND:'

export const PROFILE_SYSTEM_PROMPT = `You compile a company profile for a venture fund's diligence data room, using only the Specter tools you have.

Steps:
1. Resolve the company from what the partner gave you (a website domain is best; otherwise a name). If several companies could match and none clearly does, stop and answer with one line: "${NOT_FOUND_PREFIX} <which candidates you found and why none clearly matches>". If nothing matches, answer "${NOT_FOUND_PREFIX} <what you searched>".
2. Pull what Specter has on it: overview, funding rounds and investors, team and founders' backgrounds, headcount and traction signals, competitors, recent news.
3. Write the profile in Markdown, and nothing else, in this shape:

# <Company name>

<one-paragraph overview: what it does, where, founded when, website>

## Funding and investors
## Team
## Traction signals
## Competitors
## Recent news
## Source

Rules:
- Use only what the tools returned. Never fill a gap from memory or guess a figure; write "Not in Specter." under a heading with nothing to report.
- Give dates for rounds, news and signals, and say how fresh a figure is when the tool says.
- Keep figures exactly as returned, with their currency and units.
- Under "Source", say the profile was compiled from Specter on the date given, and list the Specter tools you used.`

export interface SpecterProfile {
  /** The Markdown document, or null when the company couldn't be resolved. */
  markdown: string | null
  /** The company name from the profile's title, for the file name. */
  companyName: string | null
  /** Why there is no profile, when there isn't one. */
  notFound: string | null
  loop: ToolLoopResult
}

/** The `# Title` line of a profile, or null. */
export function profileTitle(markdown: string): string | null {
  const m = markdown.match(/^#\s+(.+?)\s*$/m)
  return m ? m[1].trim() : null
}

/** Strip a code fence the model may wrap the document in. */
export function unwrapMarkdown(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  return (fenced ? fenced[1] : trimmed).trim()
}

export async function compileSpecterProfile(input: {
  provider: AIProvider
  model: string
  server: McpServerConfig
  query: string
  dealName: string
  today: string
}): Promise<SpecterProfile> {
  if (!input.provider.supportsToolLoop || !input.provider.createToolLoop) {
    throw new Error('Specter profiles need Claude as the AI provider.')
  }
  const loop = await input.provider.createToolLoop({
    model: input.model,
    maxTokens: 4000,
    system: withTopicalGuardrail(PROFILE_SYSTEM_PROMPT),
    content: `Deal name in our pipeline: ${input.dealName}\nCompany to look up: ${input.query}\nToday's date: ${input.today}`,
    mcpServers: [input.server],
    maxIterations: 4,
  })
  const text = unwrapMarkdown(loop.text)
  if (!text || text.startsWith(NOT_FOUND_PREFIX)) {
    return {
      markdown: null,
      companyName: null,
      notFound: text ? text.slice(NOT_FOUND_PREFIX.length).trim() : 'Specter returned nothing for that company.',
      loop,
    }
  }
  return { markdown: text, companyName: profileTitle(text), notFound: null, loop }
}

/** A file name that is safe in storage paths and readable in the data room. */
export function profileFileName(companyName: string | null, fallback: string, today: string): string {
  const name = (companyName || fallback).replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Company'
  return `Specter profile - ${name} (${today}).md`
}

/** Upload the profile and add it to the deal's documents. Returns the new document id. */
export async function saveProfileToDataRoom(admin: SupabaseClient, input: {
  fundId: string
  dealId: string
  userId: string
  fileName: string
  markdown: string
}): Promise<string> {
  const body = Buffer.from(input.markdown, 'utf-8')
  const storagePath = `${input.dealId}/${Date.now()}_specter_profile.md`
  const { error: upErr } = await admin.storage
    .from('diligence-documents')
    .upload(storagePath, body, { contentType: 'text/markdown', upsert: false })
  if (upErr) throw new Error(`Could not store the profile: ${upErr.message}`)

  const { data: row, error } = await (admin as any)
    .from('diligence_documents')
    .insert({
      deal_id: input.dealId,
      fund_id: input.fundId,
      storage_path: storagePath,
      file_name: input.fileName,
      file_format: 'md',
      file_size_bytes: body.length,
      // detected_type must come from data_room_ingestion.yaml; ingest refines it.
      detected_type: 'other',
      type_confidence: 'low',
      parse_status: 'pending',
      source_kind: 'specter',
      uploaded_by: input.userId,
    })
    .select('id')
    .single()
  if (error) {
    await admin.storage.from('diligence-documents').remove([storagePath]).catch(() => {})
    throw new Error(`Could not add the profile to the data room: ${error.message}`)
  }
  return (row as any).id as string
}
