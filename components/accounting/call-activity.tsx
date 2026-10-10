'use client'

import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * One capital call laid out the way a fund administrator's capital-activity report is (Carta's
 * "Capital Activity Detail"): per investor, the commitment, this call's contribution, what was met
 * from a prepaid contribution, what has been received, any balance carried from earlier calls, the
 * total due, and the commitment left after the call. Participating investors first, then the ones
 * with a commitment who were not called. The same rows download as .xlsx.
 */

import { HEADERS, callActivityRows, type Call, type IssuedCall, type Partner } from '@/lib/accounting/call-activity'

export function CallActivity({ call, calls, partners, fmt, fileName }: {
  call: Call
  calls: IssuedCall[]
  partners: Partner[]
  fmt: (n: number) => string
  fileName: string
}) {
  const { participating, notCalled } = callActivityRows(call, calls, partners)
  const sum = (k: keyof (typeof participating)[number]) => participating.reduce((s, r) => s + (Number(r[k]) || 0), 0)
  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`)

  async function download() {
    const XLSX = await import('xlsx')
    const aoa: (string | number | null)[][] = [HEADERS, ['Participating Investors']]
    for (const r of participating) aoa.push([r.name, r.commitment, r.contribution, r.prepaid, r.received, r.earlierOutstanding, r.charges, r.totalDue, r.postCall, r.postCallPct])
    if (notCalled.length) { aoa.push([], ['Non-Participating Investors']); for (const n of notCalled) aoa.push([n]) }
    aoa.push([], ['Total', sum('commitment'), sum('contribution'), sum('prepaid'), sum('received'), sum('earlierOutstanding'), sum('charges'), sum('totalDue'), sum('postCall'), null])
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Capital Activity Detail')
    XLSX.writeFile(wb, fileName)
  }

  const num = 'px-2 py-1.5 text-right tabular-nums'
  return (
    <div className="mt-2 space-y-2">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b bg-muted/50 text-muted-foreground">
              {HEADERS.map((h, i) => <th key={h} className={`px-2 py-1.5 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {participating.map(r => (
              <tr key={r.name} className="border-b last:border-b-0">
                <td className="px-2 py-1.5">{r.name}</td>
                <td className={num}>{fmt(r.commitment)}</td>
                <td className={num}>{fmt(r.contribution)}</td>
                <td className={`${num} ${r.prepaid ? '' : 'text-muted-foreground'}`}>{fmt(r.prepaid)}</td>
                <td className={`${num} ${r.received ? '' : 'text-muted-foreground'}`}>{fmt(r.received)}</td>
                <td className={`${num} ${r.earlierOutstanding ? '' : 'text-muted-foreground'}`}>{fmt(r.earlierOutstanding)}</td>
                <td className={`${num} ${r.charges ? '' : 'text-muted-foreground'}`}>{fmt(r.charges)}</td>
                <td className={num}>{fmt(r.totalDue)}</td>
                <td className={num}>{fmt(r.postCall)}</td>
                <td className={num}>{pct(r.postCallPct)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t bg-muted/30 font-medium">
              <td className="px-2 py-1.5">Total</td>
              {(['commitment', 'contribution', 'prepaid', 'received', 'earlierOutstanding', 'charges', 'totalDue', 'postCall'] as const).map(k => <td key={k} className={num}>{fmt(sum(k))}</td>)}
              <td className={num} />
            </tr>
          </tfoot>
        </table>
      </div>
      {notCalled.length > 0 && (
        <p className="text-xs text-muted-foreground">Not called: {notCalled.join(', ')}</p>
      )}
      <Button size="sm" variant="outline" onClick={download} className="gap-1.5"><Download className="h-3.5 w-3.5" />Download .xlsx</Button>
    </div>
  )
}
