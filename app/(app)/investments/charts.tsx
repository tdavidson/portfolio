'use client'

/**
 * The two charts above the investments tables.
 *
 * They answer the two questions the tables make a reader do arithmetic for: which positions carry
 * the portfolio and how each is marked against what it cost, and whether the value comes from a
 * few outsized outcomes or is spread across the book.
 *
 * Both are drawn from the same rows the tables below them show, so the vehicle, type and status
 * filters apply here too. A holding owned through several vehicles is one row in the tables per
 * vehicle and one bar here (lib/charts/holdings.ts sums it).
 */

import { useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LabelList,
} from 'recharts'
import { AXIS, ChartCard, EmptyPlot, HELD_HUE, HUE, INVEST_NEW, PROCEEDS_HUE, tooltipStyle } from '@/components/fund-chart-kit'
import { RankedBars } from '@/components/ranked-bars'
import { foldPositions, heldPositions, positionsByHolding, type HoldingPosition, type HoldingRow } from '@/lib/charts/holdings'
import { multipleBuckets, othersLabel, ratio } from '@/lib/charts/ranked'
import { holdingHref } from '@/lib/portfolio/holding-href'

type Fmt = (v: number) => string

const STATUS_BADGE: Record<string, string | undefined> = { exited: 'Exited', 'written-off': 'Written off' }

const multiple = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)
const holdings = (n: number) => `${n} ${n === 1 ? 'holding' : 'holdings'}`

export function InvestmentCharts({ rows, fmt, fmtFull }: { rows: HoldingRow[]; fmt: Fmt; fmtFull: Fmt }) {
  const positions = useMemo(() => positionsByHolding(rows), [rows])
  if (positions.length === 0) return null
  return (
    <div className="grid gap-4 lg:grid-cols-2 mb-8">
      <FairValueAndCost positions={positions} fmt={fmt} fmtFull={fmtFull} />
      <ValueByMultiple positions={positions} fmt={fmt} fmtFull={fmtFull} />
    </div>
  )
}

// ── Fair value and cost by holding ───────────────────────────────────────────
//
// The bar is what the position is carried at; the tick is what it cost. Bar past the tick is a
// markup, bar short of it a markdown. Ranked by fair value, so the top of the chart is where the
// portfolio's value sits.

function FairValueAndCost({ positions, fmt, fmtFull }: { positions: HoldingPosition[]; fmt: Fmt; fmtFull: Fmt }) {
  const held = useMemo(() => heldPositions(positions), [positions])

  return (
    <ChartCard title="Fair value and cost by holding">
      {held.length === 0 ? (
        <EmptyPlot label="Nothing is currently held." />
      ) : (
        <RankedBars
          items={held}
          rank={p => p.fairValue}
          fold={rest => foldPositions(rest, othersLabel(rest.length))}
          noun="holdings"
          series={[{ name: 'Fair value', color: HELD_HUE }]}
          referenceLabel="Current cost"
          valueHeader="Fair value"
          noteHeader="Of cost"
          row={p => {
            const of = ratio(p.fairValue, p.cost)
            return {
              key: p.companyId || p.name,
              label: p.name,
              href: p.companyId ? holdingHref(p.companyId) : undefined,
              muted: !p.companyId,
              badge: STATUS_BADGE[p.status],
              values: [p.fairValue],
              reference: p.cost,
              value: fmt(p.fairValue),
              valueTitle: fmtFull(p.fairValue),
              note: multiple(of),
              summary: `${p.name}: fair value ${fmtFull(p.fairValue)} against a cost of ${fmtFull(p.cost)}${of == null ? '' : `, ${multiple(of)}`}`,
            }
          }}
        />
      )}
    </ChartCard>
  )
}

// ── Invested and total value by multiple ─────────────────────────────────────
//
// Every holding sorted into a band by its gross multiple, realized and unrealized together. The
// pair of columns in each band is what went in and what it is worth (proceeds received, then what
// is still held): a venture book usually has most of its capital on the left and most of its
// value on the right.

const SERIES = [
  { name: 'Invested', color: INVEST_NEW },
  { name: 'Proceeds', color: PROCEEDS_HUE },
  { name: 'Fair value', color: HELD_HUE },
]

function ValueByMultiple({ positions, fmt, fmtFull }: { positions: HoldingPosition[]; fmt: Fmt; fmtFull: Fmt }) {
  const buckets = useMemo(() => multipleBuckets(positions), [positions])
  const counted = buckets.reduce((s, b) => s + b.count, 0)
  const countOf = useMemo(() => new Map(buckets.map(b => [b.label, b.count])), [buckets])

  // The band's name with its holding count underneath: the count is what says whether a tall
  // column is one outlier or a dozen positions, and it should not need a hover.
  const tick = ({ x, y, payload }: any) => (
    <g transform={`translate(${x},${y})`}>
      <text textAnchor="middle" dy={12} fontSize={11} fill={HUE.muted}>{payload.value}</text>
      <text textAnchor="middle" dy={26} fontSize={10} fill={HUE.muted} opacity={0.75}>{holdings(countOf.get(payload.value) ?? 0)}</text>
    </g>
  )

  // A figure over each column, dropped when the columns get too narrow to hold one without
  // running into its neighbour (the tooltip and the axis still carry the value there).
  const label = (props: any) => {
    const value = Number(props.value)
    if (!(value > 0) || props.width < 26) return null
    return (
      <text x={props.x + props.width / 2} y={props.y - 4} textAnchor="middle" fontSize={10} fill={HUE.muted} className="tabular-nums">
        {fmt(value)}
      </text>
    )
  }

  return (
    <ChartCard title="Invested and total value by multiple">
      {counted === 0 ? (
        <EmptyPlot label="No invested capital yet." />
      ) : (
        <>
          {/* The same legend the row charts use, rather than recharts' own: that one sorts the
              series alphabetically and sets each name in its series colour. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {SERIES.map(s => (
              <span key={s.name} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} /> {s.name}
              </span>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={buckets} margin={{ top: 16, right: 8, bottom: 0, left: 8 }} barGap={6} barCategoryGap="18%">
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
              <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={false} interval={0} height={40} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52} tickFormatter={v => fmt(v as number)} className="text-muted-foreground" />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                contentStyle={tooltipStyle}
                labelFormatter={l => `${l} · ${holdings(countOf.get(String(l)) ?? 0)}`}
                formatter={(v: any, n: any) => [fmtFull(v as number), n]}
              />
              {/* Its own stack id, or recharts draws the stacked column first and the pair reads
                  value-then-cost, the reverse of the legend. */}
              <Bar dataKey="invested" name="Invested" stackId="invested" fill={INVEST_NEW} maxBarSize={44} stroke={HUE.surface} strokeWidth={1}>
                <LabelList dataKey="invested" content={label} />
              </Bar>
              {/* Total value is one column in two parts, so the band also says how much of its
                  value is in hand. The figure over it is the whole column. */}
              <Bar dataKey="realized" name="Proceeds" stackId="value" fill={PROCEEDS_HUE} maxBarSize={44} stroke={HUE.surface} strokeWidth={1} />
              <Bar dataKey="held" name="Fair value" stackId="value" fill={HELD_HUE} maxBarSize={44} stroke={HUE.surface} strokeWidth={1}>
                <LabelList dataKey="totalValue" content={label} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-1 text-xs text-muted-foreground">
            Holdings grouped by gross multiple: proceeds received plus fair value, over capital invested.
          </p>
        </>
      )}
    </ChartCard>
  )
}
