import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { buildDocxBuffer, exportToGoogleDocs } from '@/lib/lp-letters/export'
import { investorText } from '@/lib/lp-letters/internal'
import { fundDriveToken } from '@/lib/google/fund-drive'
import { outcomeResponse } from '@/lib/service-outcome'
import type { CompanyNarrative } from '@/lib/types/database'

interface StoredPortfolioCompany {
  company_id: string
  company_name: string
  status: string
  stage: string | null
  total_invested: number
  fmv: number
  moic: number | null
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const { format } = await req.json()
  if (!['markdown', 'docx', 'google-docs'].includes(format)) {
    return NextResponse.json({ error: 'Invalid format. Use markdown, docx, or google-docs.' }, { status: 400 })
  }

  const { data: letter, error } = await admin
    .from('lp_letters')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()

  if (error) return dbError(error, 'lp-letters-export')
  if (!letter) return NextResponse.json({ error: 'Letter not found' }, { status: 404 })

  // Get fund name + currency
  const { data: fund } = await admin.from('funds').select('name').eq('id', fundId).single()
  const fundName = fund?.name ?? 'Fund'

  const { data: fundSettings } = await admin
    .from('fund_settings')
    .select('currency')
    .eq('fund_id', fundId)
    .maybeSingle()
  const currency = fundSettings?.currency ?? 'USD'

  const narratives: CompanyNarrative[] = Array.isArray(letter.company_narratives)
    ? (letter.company_narratives as unknown as CompanyNarrative[])
    : []

  // Use stored portfolio summary from generation (no recalculation)
  const storedSummary: StoredPortfolioCompany[] = Array.isArray(letter.portfolio_summary)
    ? (letter.portfolio_summary as unknown as StoredPortfolioCompany[])
    : []

  const portfolioCompanies = storedSummary.map(c => ({
    companyName: c.company_name,
    status: c.status,
    stage: c.stage,
    totalInvested: c.total_invested,
    fmv: c.fmv,
    moic: c.moic,
  }))

  const exportData = {
    period_label: letter.period_label,
    // Exports are what the partners send: the "Missing information" section stays out of them.
    full_draft: investorText(letter.full_draft),
    company_narratives: narratives,
    portfolio_companies: portfolioCompanies,
    fund_currency: currency,
  }

  // Markdown export
  if (format === 'markdown') {
    const content = exportData.full_draft
    const filename = `${fundName} - ${letter.period_label}.md`
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    })
  }

  // DOCX export
  if (format === 'docx') {
    try {
      const buffer = await buildDocxBuffer(exportData, fundName)
      const filename = `${fundName} - ${letter.period_label}.docx`
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'DOCX generation failed'
      console.error('[lp-letters-export-docx]', err)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // Google Docs export
  if (format === 'google-docs') {
    try {
      const drive = await fundDriveToken(admin, fundId)
      if (!drive.ok) return outcomeResponse(drive)
      const { accessToken, folderId: driveFolderId } = drive.value

      const url = await exportToGoogleDocs(exportData, fundName, accessToken, driveFolderId)
      return NextResponse.json({ url })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to export to Google Docs'
      console.error('[lp-letters-export-gdocs]', message)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Unknown format' }, { status: 400 })
}
