import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { aggregatePortfolioData } from '@/lib/lp-letters/aggregate'
import { generateCompanyNarrative } from '@/lib/lp-letters/generate'
import { letterVoice, voiceAsStyleGuide } from '@/lib/lp-letters/skill'
import { templateForLetter } from '@/lib/lp-letters/draft-from-brief'
import type { CompanyNarrative } from '@/lib/types/database'
import { rateLimit } from '@/lib/rate-limit'

export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ id: string; companyId: string }> }
) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const limited = await rateLimit({ key: `lp-letter-regen:${user.id}`, limit: 10, windowSeconds: 300 })
  if (limited) return limited

  // Get the letter
  const { data: letter } = await admin
    .from('lp_letters')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()

  if (!letter) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The letter's voice: its template (else the fund's default), with its examples and house rules,
  // else the lp-quarterly-letter skill's general voice.
  const styleGuide = voiceAsStyleGuide(letterVoice(await templateForLetter(admin, fundId, letter.template_id)))

  // Aggregate data
  const preview = await aggregatePortfolioData(
    admin, fundId,
    letter.period_year, letter.period_quarter,
    letter.portfolio_group, letter.is_year_end
  )

  const company = preview.companies.find(c => c.investment.companyId === params.companyId)
  if (!company) return NextResponse.json({ error: 'Company not found in this letter' }, { status: 404 })

  // Generate
  const companyPrompts = (letter.company_prompts && typeof letter.company_prompts === 'object')
    ? letter.company_prompts as Record<string, { prompt: string; mode: 'add' | 'replace' }>
    : null
  const companyPrompt = companyPrompts?.[params.companyId] ?? null

  const { provider, model, providerType } = await createFundAIProvider(admin, fundId)
  const { narrative, usage } = await generateCompanyNarrative(
    provider, model, company, preview, styleGuide, letter.generation_prompt, companyPrompt
  )

  // Update the narrative in the JSONB array
  const narratives: CompanyNarrative[] = Array.isArray(letter.company_narratives)
    ? (letter.company_narratives as unknown as CompanyNarrative[])
    : []

  const existingIdx = narratives.findIndex(n => n.company_id === params.companyId)
  const updatedNarrative: CompanyNarrative = {
    company_id: params.companyId,
    company_name: company.investment.companyName,
    narrative,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  }

  if (existingIdx >= 0) {
    narratives[existingIdx] = updatedNarrative
  } else {
    narratives.push(updatedNarrative)
  }

  await admin
    .from('lp_letters')
    .update({
      company_narratives: narratives as any,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)

  await logAIUsage(admin, {
    fundId,
    userId: user.id,
    provider: providerType,
    model,
    feature: 'lp-letter-regenerate-company',
    usage,
  })

  return NextResponse.json({ narrative: updatedNarrative, usage })
}
