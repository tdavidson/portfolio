import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertReadAccess } from '@/lib/api-helpers'
import { createFundAIProvider } from '@/lib/ai'
import type { ContentBlock } from '@/lib/ai'
import { extractText } from '@/lib/memo-agent/extract-text'
import { validateExtraction, EXTRACTION_PROMPT, EXTRACTION_SCHEMA } from '@/lib/portfolio/fof-extract'
import { matchHoldings } from '@/lib/portfolio/fof-paste'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'

/**
 * Read a manager's quarterly document into the same reviewable rows the paste grid produces.
 *
 * WRITES NOTHING. This is a proposal: the user reviews the rows and applies them through
 * POST /api/accounting/fof-grid { apply: true } — the one write path, which the paste grid
 * already uses. Extraction that wrote directly would be a second way into the register with a
 * model on the other end of it.
 *
 * Read access, not write: proposing costs nothing and changes nothing. Applying needs write,
 * and the grid route enforces that.
 *
 * POST — { fileBase64, mediaType, fileName } | { text }
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const hasFile = typeof body?.fileBase64 === 'string' && body.fileBase64.length > 0
  const hasText = typeof body?.text === 'string' && body.text.trim().length > 0
  if (!hasFile && !hasText) {
    return NextResponse.json({ error: 'Upload a document or paste its text.' }, { status: 400 })
  }

  let ai
  try {
    ai = await createFundAIProvider(admin as any, gate.fundId)
  } catch {
    // A missing key is a setup state, not a crash.
    return NextResponse.json({
      error: 'No AI provider is configured for this fund. Add a key in Settings, or paste the figures into the grid instead.',
    }, { status: 400 })
  }

  // A PDF goes to the model AS A DOCUMENT where the provider supports it: statements are
  // tables, and table structure is exactly what survives in the document block and dies in
  // flattened text. Text extraction is the fallback, not the default.
  const content: ContentBlock[] = []
  const mediaType = typeof body?.mediaType === 'string' ? body.mediaType : 'application/pdf'
  if (hasFile && mediaType === 'application/pdf') {
    content.push({ type: 'document', mediaType, data: body.fileBase64 })
  } else if (hasFile) {
    const buf = Buffer.from(body.fileBase64, 'base64')
    const text = await extractText(buf, mediaType).catch(() => null)
    if (!text) {
      return NextResponse.json({ error: 'Could not read that file. Paste the figures instead.' }, { status: 400 })
    }
    content.push({ type: 'text', text })
  } else {
    content.push({ type: 'text', text: body.text })
  }

  content.push({
    type: 'text',
    text: `Return ONLY JSON matching this schema, with no commentary:\n${JSON.stringify(EXTRACTION_SCHEMA)}`,
  })

  let parsed: unknown = null
  let rawText = ''
  try {
    const result = await ai.provider.createMessage({
      model: ai.model,
      maxTokens: 4000,
      system: EXTRACTION_PROMPT,
      content,
    })
    rawText = result.text ?? ''
    parsed = parseJsonLoosely(rawText)
  } catch (e) {
    return NextResponse.json({ error: `The extractor failed: ${(e as Error).message}` }, { status: 502 })
  }

  const { rows, warnings } = validateExtraction(parsed)

  // Matched only against fund holdings the caller can see.
  const scope = await loadEntityScopeForUser(admin, gate.userId)
  const { data: holdings } = await filterByCompany(admin
    .from('companies').select('id, name, aliases')
    .eq('fund_id', gate.fundId).eq('holding_type', 'fund'), scope ? scope.companyIds : [], { column: 'id' })

  const matched = matchHoldings(rows, ((holdings as any[]) ?? []).map(h => ({
    id: h.id, name: h.name, aliases: h.aliases,
  })))

  return NextResponse.json({
    // Matched rows carry their extraction metadata through, so review happens against the
    // statement rather than against a tidy table.
    matched: matched.filter(m => m.companyId).map((m, i) => ({
      companyId: m.companyId, matchedName: m.matchedName, ...m.row,
      confidence: rows[i]?.confidence, sourceText: rows[i]?.sourceText,
    })),
    unmatched: matched.filter(m => !m.companyId).map(m => m.row.fundName),
    warnings,
    // Empty rows from a real document usually means it was not a statement at all.
    ...(rows.length === 0 ? { note: 'Nothing financial was found in that document.' } : {}),
  })
}

/** Models fence JSON, prepend prose, or both. Salvage the object rather than failing on it. */
function parseJsonLoosely(text: string): unknown {
  const trimmed = text.trim()
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1]) } catch { /* fall through */ } }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)) } catch { /* fall through */ }
  }
  return null
}
