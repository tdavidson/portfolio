import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { aggregatePortfolioData } from '@/lib/lp-letters/aggregate'
import { buildPortfolioTableHtml, generateAllNarratives, assembleFullDraft } from '@/lib/lp-letters/generate'
import { sanitizeLetterHtml } from '@/lib/sanitize'
import { letterVoice } from '@/lib/lp-letters/skill'
import { logActivity } from '@/lib/activity'
import { rateLimit } from '@/lib/rate-limit'

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const limited = await rateLimit({ key: `lp-letter-gen:${user.id}`, limit: 5, windowSeconds: 300 })
  if (limited) return limited

  // Get the letter
  const { data: letter } = await admin
    .from('lp_letters')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()

  if (!letter) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Get the template style guide
  // The letter's voice: its template's style guide, else the lp-quarterly-letter skill's general voice.
  let savedGuide: string | null = null
  if (letter.template_id) {
    const { data: template } = await admin
      .from('lp_letter_templates')
      .select('style_guide')
      .eq('id', letter.template_id)
      .maybeSingle()
    savedGuide = template?.style_guide ?? null
  }
  const styleGuide = letterVoice(savedGuide ? { name: 'template', styleGuide: savedGuide } : null).voice

  // Set status to generating, clear any previous error
  await admin
    .from('lp_letters')
    .update({ status: 'generating', generation_error: null, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  try {
    // Aggregate data
    const preview = await aggregatePortfolioData(
      admin, fundId,
      letter.period_year, letter.period_quarter,
      letter.portfolio_group, letter.is_year_end
    )

    // Build portfolio table.
    //
    // Sanitized on the way IN as well as on the way out. The generator escapes the database strings
    // it interpolates, so this is not distrust of it — it is the persistence half of SEC-004: what
    // lands in `lp_letters.portfolio_table_html` should already be safe, so a future reader that
    // forgets to sanitize is not the whole defense. The render boundaries sanitize too.
    const portfolioTableHtml = sanitizeLetterHtml(buildPortfolioTableHtml(preview)) ?? ''

    // Generate narratives
    const { provider, model, providerType } = await createFundAIProvider(admin, fundId)
    const companyPrompts = (letter.company_prompts && typeof letter.company_prompts === 'object')
      ? letter.company_prompts as Record<string, { prompt: string; mode: 'add' | 'replace' }>
      : null
    const { narratives, totalUsage } = await generateAllNarratives(
      provider, model, preview, styleGuide, letter.generation_prompt, companyPrompts
    )

    // Assemble full draft
    const fullDraft = assembleFullDraft(preview, portfolioTableHtml, narratives, preview.fundCurrency)

    // Store portfolio summary for export (avoids recalculating from transactions)
    const portfolioSummary = preview.companies.map(c => ({
      company_id: c.investment.companyId,
      company_name: c.investment.companyName,
      status: c.investment.status,
      stage: c.investment.stage,
      total_invested: c.investment.totalInvested,
      fmv: c.investment.fmv,
      moic: c.investment.moic,
    }))

    // Save
    await admin
      .from('lp_letters')
      .update({
        portfolio_table_html: portfolioTableHtml,
        company_narratives: narratives as any,
        full_draft: fullDraft,
        portfolio_summary: portfolioSummary as any,
        source: 'generated',
        generated_by: 'fund_ai',
        status: 'draft',
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.id)

    // Log usage
    await logAIUsage(admin, {
      fundId,
      userId: user.id,
      provider: providerType,
      model,
      feature: 'lp-letter-generation',
      usage: totalUsage,
    })

    logActivity(admin, fundId, user.id, 'lp-letter.generate', {
      letterId: params.id,
      periodLabel: letter.period_label,
      companiesCount: narratives.length,
    })

    // Return updated letter
    const { data: updated } = await admin
      .from('lp_letters')
      .select('*')
      .eq('id', params.id)
      .single()

    return NextResponse.json(updated)
  } catch (err) {
    const internalError = err instanceof Error ? err.message : 'Generation failed'
    // Log the full error server-side, store a safe message for the UI
    console.error('[lp-letters] Generation error detail:', internalError)
    await admin
      .from('lp_letters')
      .update({ status: 'draft', generation_error: 'Letter generation failed. Please try again.', updated_at: new Date().toISOString() })
      .eq('id', params.id)

    return NextResponse.json({ error: 'Letter generation failed. Please try again.' }, { status: 500 })
  }
}
