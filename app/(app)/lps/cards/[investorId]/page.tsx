'use client'

// A single investor's LIVE report card. Same layout as the batch and the frozen snapshot
// cards; browser-printed so it sets in the reader's system font.

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2, ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LpReportCard, REPORT_CARD_PRINT_CSS, type ReportCardRow, type ReportCardTotals } from '@/components/lp-report-card'
import { formatAsOf } from '@/lib/report-card-footer'

interface Investor { investorId: string; investorName: string; rows: ReportCardRow[]; asOf: string | null }
interface Payload {
  fund: { name: string; logo: string | null; address: string | null }
  currency: string
  description: string | null
  footer: string | null
  asOf: string | null
  investors: Investor[]
}

const add = (a: number | null, b: number | null): number | null => a == null || b == null ? null : a + b
const ratio = (n: number | null, d: number | null): number | null => (n != null && d != null && d > 0 ? n / d : null)
function totalsOf(rows: ReportCardRow[]): ReportCardTotals {
  const t = rows.reduce<Pick<ReportCardTotals, 'commitment' | 'paidInCapital' | 'distributions' | 'nav' | 'totalValue'>>((a, r) => ({
    commitment: a.commitment + r.commitment, paidInCapital: add(a.paidInCapital, r.paidInCapital),
    distributions: add(a.distributions, r.distributions), nav: add(a.nav, r.nav), totalValue: add(a.totalValue, r.totalValue),
  }), { commitment: 0, paidInCapital: 0, distributions: 0, nav: 0, totalValue: 0 })
  return { ...t, pctFunded: ratio(t.paidInCapital, t.commitment), dpi: ratio(t.distributions, t.paidInCapital), rvpi: ratio(t.nav, t.paidInCapital), tvpi: ratio(add(t.distributions, t.nav), t.paidInCapital) }
}

export default function LiveCardPage() {
  const params = useParams()
  const investorId = String(params.investorId)
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/lps/live-cards?investor=${encodeURIComponent(investorId)}`).then(r => (r.ok ? r.json() : null)).then(setData).finally(() => setLoading(false))
  }, [investorId])
  useEffect(() => { load() }, [load])

  // An investor grouped under a parent opens the parent's card (the only one returned).
  const investor = data?.investors.find(i => i.investorId === investorId) ?? (data?.investors.length === 1 ? data.investors[0] : undefined)

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4 w-full print:p-0">
      <style>{REPORT_CARD_PRINT_CSS}</style>
      <div className="flex items-center gap-3 mb-6 no-print">
        <Button variant="outline" size="sm" className="text-muted-foreground" asChild>
          <Link href="/lps"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link>
        </Button>
        <span className="flex-1" />
        <Button size="sm" onClick={() => window.print()} disabled={!investor}>
          <Printer className="h-4 w-4 mr-1" /> Save PDF
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center py-16 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Building card…</div>
      ) : !investor || !data ? (
        <p className="text-sm text-muted-foreground">Investor not found in the live report.</p>
      ) : (
        <LpReportCard
          fundName={data.fund.name}
          fundLogo={data.fund.logo}
          fundAddress={data.fund.address}
          investorName={investor.investorName}
          rows={investor.rows}
          totals={totalsOf(investor.rows)}
          description={data.description}
          footerNote={data.footer || undefined}
          asOfFormatted={formatAsOf(investor.asOf) ?? undefined}
        />
      )}
    </div>
  )
}
