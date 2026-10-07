import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { logActivity } from '@/lib/activity'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'

interface MatchResult {
  filename: string
  companyId: string | null
  companyName: string | null
  confidence: string
}

// ---------------------------------------------------------------------------
// POST — Match filenames to portfolio companies using Claude
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Get user's fund
  const { data: membership } = await supabase
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle() as { data: { fund_id: string } | null }

  if (!membership) return NextResponse.json({ error: 'No fund membership' }, { status: 403 })

  const fundId = membership.fund_id

  const body = await req.json()
  const { filenames } = body as { filenames: string[] }

  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json({ error: 'filenames array is required' }, { status: 400 })
  }

  // Fetch active companies
  // Matched only against companies the caller can see.
  const scope = await loadEntityScopeForUser(admin, user.id)
  const { data: companies } = await filterByCompany(admin
    .from('companies')
    .select('id, name, aliases')
    .eq('fund_id', fundId)
    .eq('holding_type', 'company')   // fund holdings have their own surfaces
    .eq('status', 'active'), scope ? scope.companyIds : [], { column: 'id' })

  if (!companies || companies.length === 0) {
    return NextResponse.json({
      matches: filenames.map(f => ({ filename: f, companyId: null, companyName: null, confidence: 'none' })),
    })
  }

  // Get AI provider
  let provider: Awaited<ReturnType<typeof createFundAIProvider>>['provider']
  let claudeModel: string
  let aiProviderType: string
  try {
    const result = await createFundAIProvider(admin, fundId)
    provider = result.provider
    claudeModel = result.model
    aiProviderType = result.providerType
  } catch {
    return NextResponse.json({
      error: 'Claude API key not configured. Add one in Settings.',
    }, { status: 400 })
  }

  const companyList = companies.map(c => ({
    id: c.id,
    name: c.name,
    aliases: c.aliases ?? [],
  }))

  const prompt = `Given these document filenames and these portfolio companies, match each file to the most likely company.
Match by company name appearing in the filename, common abbreviations, or project codenames.
If no confident match, return null for companyId and companyName.

Filenames: ${JSON.stringify(filenames)}

Companies: ${JSON.stringify(companyList)}

Return JSON only, no prose. Format:
{ "matches": [{ "filename": "...", "companyId": "..." or null, "companyName": "..." or null, "confidence": "high"|"medium"|"low"|"none" }] }`

  try {
    const { text, usage } = await provider.createMessage({
      model: claudeModel,
      maxTokens: 2048,
      system: 'You are a portfolio reporting assistant. Match document filenames to portfolio companies. Return JSON only.',
      content: prompt,
    })

    logAIUsage(admin, {
      fundId,
      userId: user.id,
      provider: aiProviderType,
      model: claudeModel,
      feature: 'import_documents',
      usage,
    })

    logActivity(admin, fundId, user.id, 'import.documents', { fileCount: filenames.length })

    // Parse the response
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed = JSON.parse(cleaned) as { matches: MatchResult[] }

    return NextResponse.json({ matches: parsed.matches, fundId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[import/documents] Claude matching error:', message)
    return NextResponse.json({ error: 'Matching failed. Check your API key in Settings.' }, { status: 500 })
  }
}
