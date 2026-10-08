'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCurrency, formatCurrency } from '@/components/currency-context'
import { AddFundHoldingButton } from '@/components/add-fund-holding-button'
import { FundHoldingDetail } from '@/components/fund-holding-detail'

/** Mirrors FundPosition from lib/portfolio/fof-metrics.ts — every figure derived, none stored. */
interface FundPosition {
  companyId: string
  name: string
  managerName: string | null
  vintageYear: number | null
  strategy: string | null
  commitment: number
  contributed: number
  distributed: number
  recallableReturned: number
  unfunded: number
  pctCalled: number | null
  reportedNav: number | null
  navAsOf: string | null
  navBasis: 'final' | 'preliminary' | 'estimate' | null
  stalenessDays: number | null
  carryingValue: number
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  netIrr: number | null
  vehicleId: string | null
  vehicleName: string | null
  key: string
}

/** Managers report 45-90 days late, so past roughly one quarter is worth flagging. */
const STALE_DAYS = 100

const dash = '—'
const pct = (v: number | null) => (v === null ? dash : `${(v * 100).toFixed(1)}%`)
const mult = (v: number | null) => (v === null ? dash : `${v.toFixed(2)}x`)

export default function FundHoldingsPage() {
  const currency = useCurrency()
  const [positions, setPositions] = useState<FundPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10))
  const [openHolding, setOpenHolding] = useState<{ companyId: string; vehicleId: string | null } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/portfolio/fund-holdings?asOf=${asOf}`)
      const json = await res.json()
      setPositions(json.positions ?? [])
    } finally {
      setLoading(false)
    }
  }, [asOf])

  useEffect(() => { void load() }, [load])

  const fmt = (v: number) => formatCurrency(v, currency)
  const total = positions.reduce(
    (a, p) => ({
      commitment: a.commitment + p.commitment,
      contributed: a.contributed + p.contributed,
      distributed: a.distributed + p.distributed,
      unfunded: a.unfunded + p.unfunded,
      carrying: a.carrying + p.carryingValue,
    }),
    { commitment: 0, contributed: 0, distributed: 0, unfunded: 0, carrying: 0 },
  )
  // Totals from TOTALS, never averaged across rows — averaging 60% and 100% called gives 80%
  // when the truth for a 5-of-7 portfolio is 71.4%.
  const totalPctCalled = total.commitment > 0 ? total.contributed / total.commitment : null
  // Two entities holding the same fund are two rows; name the entity once there is more than one.
  const multiEntity = new Set(positions.map(p => p.vehicleId)).size > 1
  const totalTvpi = total.contributed > 0 ? (total.distributed + total.carrying) / total.contributed : null

  return (
    <div>
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Underlying funds</h1>
        <p className="text-sm text-muted-foreground">
          Commitments, capital called and distributed, and the latest manager NAV for each fund held.
        </p>
        <div className="flex items-center gap-2 pt-3">
          <AddFundHoldingButton onCreated={() => void load()} />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-muted-foreground">As of</span>
            <input
              type="date"
              value={asOf}
              onChange={e => setAsOf(e.target.value)}
              className="border rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
      </div>

      <Card className="rounded-card">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : positions.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No fund holdings yet. Add one to track commitments, calls and manager NAVs.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fund</TableHead>
                  {multiEntity && <TableHead>Entity</TableHead>}
                  <TableHead>Vintage</TableHead>
                  <TableHead className="text-right">Commitment</TableHead>
                  <TableHead className="text-right">Called</TableHead>
                  <TableHead className="text-right">Unfunded</TableHead>
                  <TableHead className="text-right">Distributed</TableHead>
                  <TableHead className="text-right">Carrying value</TableHead>
                  <TableHead>NAV as of</TableHead>
                  <TableHead className="text-right">% called</TableHead>
                  <TableHead className="text-right">TVPI</TableHead>
                  <TableHead className="text-right">Net IRR</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map(p => (
                  <TableRow
                    key={p.key}
                    className="cursor-pointer"
                    onClick={() => setOpenHolding({ companyId: p.companyId, vehicleId: p.vehicleId })}
                  >
                    <TableCell className="font-medium">
                      {p.name}
                      {p.managerName && <span className="block text-xs text-muted-foreground">{p.managerName}</span>}
                    </TableCell>
                    {multiEntity && <TableCell className="text-sm">{p.vehicleName ?? 'No entity yet'}</TableCell>}
                    <TableCell className="tabular-nums">{p.vintageYear ?? dash}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(p.commitment)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(p.contributed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(p.unfunded)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(p.distributed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(p.carryingValue)}</TableCell>
                    <TableCell className="tabular-nums text-xs">
                      {p.navAsOf ? (
                        <>
                          {p.navAsOf}
                          {p.stalenessDays !== null && (
                            <span className={p.stalenessDays > STALE_DAYS ? 'block text-warning' : 'block text-muted-foreground'}>
                              {p.stalenessDays}d {p.navBasis !== 'final' ? `· ${p.navBasis}` : ''}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">No statement — at cost</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{pct(p.pctCalled)}</TableCell>
                    <TableCell className="text-right tabular-nums">{mult(p.tvpi)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(p.netIrr)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-medium">Total</TableCell>
                  {multiEntity && <TableCell />}
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{fmt(total.commitment)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(total.contributed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(total.unfunded)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(total.distributed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(total.carrying)}</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{pct(totalPctCalled)}</TableCell>
                  <TableCell className="text-right tabular-nums">{mult(totalTvpi)}</TableCell>
                  {/* A portfolio IRR needs combined cash flows — it is not an average of row IRRs. */}
                  <TableCell className="text-right tabular-nums">{dash}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>

      {openHolding && (
        <FundHoldingDetail
          companyId={openHolding.companyId}
          vehicleId={openHolding.vehicleId}
          onClose={() => setOpenHolding(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  )
}
