import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildDocxBuffer } from '@/lib/lp-letters/export'

const SAMPLE_NARRATIVES = [
  {
    company_id: 'sample-1',
    company_name: 'Acme Health',
    narrative: `Acme Health continued its strong trajectory in Q4, with ARR reaching $4.2M, up 35% year-over-year. The company added 12 new enterprise customers during the quarter, bringing total contracted accounts to 87. Net revenue retention remained healthy at 118%, driven by expansion within existing health system clients.

The team closed a $15M Series B in November, led by Acme Growth Partners, which will fund expansion into the payer market. Headcount grew to 52 employees, with key hires in sales leadership and product engineering. The company's burn rate increased modestly to $380K/month as it invests in go-to-market.

One area to watch: sales cycle length has extended from 45 to 60 days as Acme moves upmarket to larger health systems. Management is addressing this by hiring dedicated enterprise sales reps and investing in a more robust demo environment.`,
    updated_by: null,
    updated_at: '2026-01-15T00:00:00Z',
  },
  {
    company_id: 'sample-2',
    company_name: 'NovaPay',
    narrative: `NovaPay processed $890M in total payment volume during Q4, a 28% increase quarter-over-quarter. Revenue reached $1.8M for the quarter, with take rates stabilizing at 20bps. The company now serves 340 merchant accounts across its core verticals of e-commerce and SaaS platforms.

The product team shipped a major update to the recurring billing module, which has been the primary driver of new customer acquisition. Churn remained low at 1.2% monthly. The company is cash-flow positive on a unit economics basis, though overall burn continues at approximately $200K/month as it builds out the compliance and risk infrastructure needed for its banking-as-a-service product, expected to launch in Q2.`,
    updated_by: null,
    updated_at: '2026-01-15T00:00:00Z',
  },
  {
    company_id: 'sample-3',
    company_name: 'Terraform Robotics',
    narrative: `Terraform Robotics completed its first three commercial deployments in Q4, generating $420K in revenue for the quarter. Each deployment represents a multi-year contract with average deal size of $1.2M. The company's autonomous warehouse robots are now operating 24/7 at two Fortune 500 logistics companies and one major grocery distributor.

Hardware reliability has been a focus area, uptime improved from 94% to 98.5% over the quarter following a firmware update to the navigation system. The pipeline is encouraging, with 8 qualified opportunities representing $12M in potential contract value. However, the sales cycle remains long (6-9 months) given the capital expenditure nature of the purchase. Cash position is $8.2M with a burn rate of $450K/month, providing approximately 18 months of runway.`,
    updated_by: null,
    updated_at: '2026-01-15T00:00:00Z',
  },
  {
    company_id: 'sample-4',
    company_name: 'Canopy Analytics',
    narrative: `Canopy Analytics had a mixed quarter. Revenue grew 15% QoQ to $620K, but fell short of the company's internal target of $700K. Two large enterprise deals slipped from Q4 into Q1 due to extended procurement processes at the buyer organizations. The team remains confident both will close in January.

On the positive side, the company's new self-serve tier launched in October and has already attracted 180 paying accounts, contributing $45K in MRR. This channel is expected to become a meaningful growth driver in 2026. The team is lean at 18 employees with a burn rate of $150K/month and $3.1M in cash, giving it over 20 months of runway.`,
    updated_by: null,
    updated_at: '2026-01-15T00:00:00Z',
  },
]

const SAMPLE_PORTFOLIO = [
  { companyName: 'Acme Health', status: 'active', stage: 'Series B', totalInvested: 1500000, fmv: 4200000, moic: 2.8 },
  { companyName: 'NovaPay', status: 'active', stage: 'Series A', totalInvested: 800000, fmv: 1600000, moic: 2.0 },
  { companyName: 'Terraform Robotics', status: 'active', stage: 'Seed', totalInvested: 500000, fmv: 750000, moic: 1.5 },
  { companyName: 'Canopy Analytics', status: 'active', stage: 'Pre-Seed', totalInvested: 250000, fmv: 375000, moic: 1.5 },
]

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const buffer = await buildDocxBuffer(
      {
        period_label: 'Q4 2025',
        full_draft: null,
        company_narratives: SAMPLE_NARRATIVES,
        portfolio_companies: SAMPLE_PORTFOLIO,
        fund_currency: 'USD',
      },
      'Demo Ventures Fund I'
    )

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${encodeURIComponent('Example LP Letter - Q4 2025.docx')}"`,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate example'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
