'use client'

import { useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell, ReferenceLine, LabelList, Treemap,
} from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import {
  ChartCard, EmptyPlot, AXIS, HUE, useAxisMoney,
  INVEST_NEW, INVEST_FOLLOW, PROCEEDS_HUE, GAINS_HUE,
} from '@/components/fund-chart-kit'
import { valueSources, type ConstructionResult } from '@/lib/accounting/construction'
import { capitalUsage } from './capital-usage'

/**
 * Three pictures of the plan the tables state in numbers.
 *
 * All three are COMPOSITIONS or SCENARIOS, never time series. The construction model carries no
 * pacing assumption — nothing in it says when a check is written — so any chart with a date axis
 * here would be inventing its own schedule. See the header of lib/accounting/construction.ts.
 *
 * They reuse the /funds/[id] chart vocabulary through components/fund-chart-kit, so "invested
 * capital" is the same hue on both pages.
 */

type Fmt = (v: number | null) => string

// ── Committed capital usage ──────────────────────────────────────────────────
//
// One horizontal 100% bar rather than the vertical stacks on the fund page: there is a single
// total here, not a series, and laid on its side the segments carry their own labels. Capital
// into deals is one hue split by intensity (deployed solid, planned as its tint) so the eye reads
// "investment" as one block that happens to be part-done; expenses take their own slots; what is
// left over is muted ink, because unallocated capital is an absence, not a category.
// Actual and forecast share a slot: the forecast is a lighter tint of what has already happened, so
// "fees" reads as one thing split in time rather than two things.
const tintOf = (hue: string) => hue.replace(/\)$/, ' / 0.45)')
const USAGE_SERIES = [
  { key: 'deployed', name: 'Invested to date', color: INVEST_NEW, forecast: false },
  { key: 'planned', name: 'Planned investments', color: INVEST_FOLLOW, forecast: true },
  { key: 'feesActual', name: 'Management fees paid', color: HUE.chart4, forecast: false },
  { key: 'feesForecast', name: 'Management fees to come', color: tintOf(HUE.chart4), forecast: true },
  { key: 'expensesActual', name: 'Fund expenses paid', color: HUE.chart5, forecast: false },
  { key: 'expensesForecast', name: 'Fund expenses to come', color: tintOf(HUE.chart5), forecast: true },
  { key: 'unallocated', name: 'Unallocated', color: HUE.muted, forecast: false },
  // Left over, split by whether the partners have paid it in: called-but-unallocated is cash the
  // fund holds (muted ink, solid), uncalled is still a promise (a tint of the same ink).
  { key: 'calledUnallocated', name: 'Called, not yet allocated', color: HUE.muted, forecast: false },
  { key: 'uncalledUnallocated', name: 'Uncalled, not yet allocated', color: 'hsl(var(--muted-foreground) / 0.35)', forecast: true },
] as const

/**
 * Where the commitment goes, as one rectangle divided by area — what has happened solid, what is
 * forecast a lighter tint of the same slot — with the legend under it carrying the dollars and the
 * share, line for line with the Capital planning table.
 */
export function CapitalUsageChart({ model, calledKnown, fmt, fmtFull }: { model: ConstructionResult; calledKnown: boolean; fmt: Fmt; fmtFull: Fmt }) {
  const { capital } = model
  const committed = capital.committedCapital

  // Sums to committed capital (lib in ./capital-usage.ts): the leftover is split into what has been
  // called and what has not, when the vehicle knows its calls.
  const row = useMemo(() => capitalUsage(capital, { calledKnown }), [capital, calledKnown])

  const series = USAGE_SERIES.filter(s => row[s.key] > 0.5)
  const pctOf = (v: number) => (committed > 0 ? `${Math.round((v / committed) * 100)}%` : '—')
  const tiles = series.map(s => ({ name: s.name, size: row[s.key], fill: s.color, ink: s.forecast ? HUE.ink : 'hsl(0 0% 100%)', caption: `${fmt(row[s.key])} · ${pctOf(row[s.key])}` }))

  return (
    <ChartCard title="Committed capital usage">
      {committed <= 0 ? (
        <EmptyPlot label="No committed capital recorded." />
      ) : (
        <div className="space-y-4">
          <ChartContainer height={220}>
            <Treemap data={tiles} dataKey="size" aspectRatio={4 / 3} stroke={HUE.surface} isAnimationActive={false}
              content={<UsageTile />}>
              <ChartTooltip content={<ChartTooltipContent />} formatter={(v: any, _n: any, item: any) => [`${fmtFull(v as number)} · ${pctOf(v as number)}`, item?.payload?.name ?? '']} />
            </Treemap>
          </ChartContainer>
          <ul className="space-y-1.5 text-xs">
            {series.map(s => (
              <li key={s.key} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{fmt(row[s.key])}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground/70">{pctOf(row[s.key])}</span>
              </li>
            ))}
          </ul>
          {calledKnown && (
            <p className="text-xs text-muted-foreground">
              Called to date <span className="tabular-nums">{fmt(row.called)}</span> ({pctOf(row.called)}) · uncalled <span className="tabular-nums">{fmt(row.uncalled)}</span> ({pctOf(row.uncalled)}){row.uncalled - row.uncalledUnallocated > 0.5 && <>, of which the forecast already uses <span className="tabular-nums">{fmt(row.uncalled - row.uncalledUnallocated)}</span></>}.
            </p>
          )}
        </div>
      )}
    </ChartCard>
  )
}

/**
 * One area of the treemap: its slot colour, a 2px surface gap around it, rounded like a card's
 * controls — and, where the area is big enough to hold it, its name and amount written in it: white
 * on a solid slot, ink on a forecast tint (which is light). Smaller areas leave it to the legend beneath.
 */
function UsageTile(props: any) {
  const { x, y, width, height, fill, name, caption, ink, depth } = props
  // Recharts also hands the content the root node, which carries no fill and so paints black:
  // drawn under the forecast tints, that turned every translucent tile near-black.
  if (depth === 0 || !(width > 0 && height > 0)) return null
  const fitsName = width >= 96 && height >= 30
  const fitsCaption = fitsName && height >= 48
  // Roughly 6.5px a character at 12px: shorten a long name rather than spill it.
  const room = Math.floor((width - 16) / 6.5)
  const label = typeof name === 'string' && name.length > room ? `${name.slice(0, Math.max(1, room - 1))}…` : name
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} ry={4} fill={fill} stroke={HUE.surface} strokeWidth={2} />
      {fitsName && (
        <text x={x + 10} y={y + 20} fontSize={12} fontWeight={500} fill={ink ?? HUE.ink} stroke="none" style={{ pointerEvents: 'none' }}>{label}</text>
      )}
      {fitsCaption && caption && (
        <text x={x + 10} y={y + 37} fontSize={11} fill={ink ?? HUE.ink} fillOpacity={0.85} stroke="none" style={{ pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' }}>{caption}</text>
      )}
    </g>
  )
}

// ── Sources of total value ───────────────────────────────────────────────────
//
// A horizontal composition bar, matching committed capital usage above. Length makes the source
// amounts easier to compare than donut angles and keeps the visual language consistent.

export function ValueSourcesChart({ model, fmt, fmtFull }: { model: ConstructionResult; fmt: Fmt; fmtFull: Fmt }) {
  const sources = useMemo(() => valueSources(model), [model])
  const axisMoney = useAxisMoney()

  const data = useMemo(() => {
    // A marked-down book has a negative forecast gain. Rather than paint a negative slice, the
    // cost segment shrinks to what the forecast actually supports — the same treatment the fund
    // page gives an underwater carrying value — so the ring still totals the forecasted value.
    const gain = sources.forecastGain
    const invested = gain >= 0 ? sources.investedAtWork : Math.max(0, sources.investedAtWork + gain)
    return [
      // The slots these amounts have on the fund page (fund-chart-kit), so proceeds, invested
      // capital and gains read the same colour on both.
      { key: 'realized', name: 'Realized proceeds', value: Math.max(0, sources.realizedProceeds), color: PROCEEDS_HUE },
      { key: 'invested', name: 'Invested capital at work', value: invested, color: INVEST_NEW },
      { key: 'gain', name: 'Unrealized gains', value: Math.max(0, gain), color: GAINS_HUE },
    ].filter(d => d.value > 0.5)
  }, [sources])

  const total = data.reduce((s, d) => s + d.value, 0)
  const row = useMemo(() => Object.fromEntries([['label', 'Total value'], ...data.map(source => [source.key, source.value])]), [data])
  const pctOf = (value: number) => total > 0 ? `${Math.round((value / total) * 100)}%` : '—'

  return (
    <ChartCard title="Sources of total value">
      {total === 0 ? (
        <EmptyPlot label="No proceeds or forecast yet." />
      ) : (
        <>
          <ChartContainer height={110}>
            <BarChart data={[row]} layout="vertical" margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" domain={[0, total]} tick={AXIS} tickLine={false} axisLine={false} tickFormatter={axisMoney} className="text-muted-foreground" />
              <YAxis type="category" dataKey="label" hide />
              <ChartTooltip cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} content={<ChartTooltipContent />} formatter={(value: any, name: any) => [`${fmtFull(value as number)} · ${pctOf(value as number)}`, name]} />
              {data.map(source => <Bar key={source.key} dataKey={source.key} name={source.name} stackId="value" fill={source.color} stroke={HUE.surface} strokeWidth={2} />)}
            </BarChart>
          </ChartContainer>
          <ul className="mt-1 space-y-1.5 text-xs">
            {data.map(d => (
              <li key={d.name} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{fmt(d.value)}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground/70">
                  {pctOf(d.value)}
                </span>
              </li>
            ))}
          </ul>
          {sources.forecastGain < 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              The forecast sits {fmt(Math.abs(sources.forecastGain))} below the cost still at work.
            </p>
          )}
        </>
      )}
    </ChartCard>
  )
}

// ── Range of return outcomes ─────────────────────────────────────────────────
//
// Net fund MOIC across the ownership-at-exit scenarios the model already derives from the plan.
// Columns, not a line: the five scenarios are discrete what-ifs (the plan ±1 and ±2 ownership
// points), and net MOIC is linear in ownership with everything else held, so a line through them
// is always straight and reads as a trajectory that does not exist. Emphasis form — the plan as
// entered in the accent hue, the what-ifs in de-emphasis grey — so the eye lands on the one
// column that is a decision and reads the others as its spread.
//
// ONE y-axis: `exitToReturnFund` is a dollar figure on a wholly different scale, so it lives in
// the tooltip rather than on a second axis.

const WHAT_IF_FILL = 'hsl(var(--muted-foreground) / 0.35)'

export function ReturnRangeChart({ model, fmt, multiple }: { model: ConstructionResult; fmt: Fmt; multiple: (v: number | null) => string }) {
  const { sensitivity, targetFundMultiple } = model.returns

  const data = useMemo(() => sensitivity.map(row => ({
    ownership: row.ownershipAtExit,
    label: `${(row.ownershipAtExit * 100).toFixed(1)}%`,
    netMoic: row.netMoic,
    exitToReturnFund: row.exitToReturnFund,
    isPlan: row.isWeightedAverage,
  })), [sensitivity])

  const hasTarget = targetFundMultiple > 0
  const last = data.length - 1

  return (
    <ChartCard title="Range of return outcomes">
      {data.length === 0 ? (
        <EmptyPlot label="Add ownership forecasts to see return scenarios." />
      ) : (
        <>
          <ChartContainer height={hasTarget ? 176 : 190}>
            <BarChart data={data} margin={{ top: 16, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} className="text-muted-foreground" />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={v => `${(v as number).toFixed(1)}x`} className="text-muted-foreground" />
              <ChartTooltip
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                content={<ChartTooltipContent />}
                labelFormatter={l => `${l} ownership at exit`}
                formatter={(v: any, _n: any, item: any) => [
                  `${multiple(v as number)} · one exit at ${fmt(item?.payload?.exitToReturnFund ?? null)} returns the fund`,
                  item?.payload?.isPlan ? 'Net MOIC (plan)' : 'Net MOIC',
                ]}
              />
              {hasTarget && (
                <ReferenceLine
                  y={targetFundMultiple}
                  stroke={HUE.muted}
                  strokeDasharray="4 4"
                  label={{ value: `Target ${targetFundMultiple}x`, position: 'insideTopLeft', fontSize: 11, fill: HUE.muted }}
                />
              )}
              <Bar dataKey="netMoic" name="Net MOIC" maxBarSize={24} radius={[4, 4, 0, 0]}>
                {data.map(d => <Cell key={d.label} fill={d.isPlan ? HUE.chart1 : WHAT_IF_FILL} />)}
                {/* Direct labels on the plan and the two ends only: enough to read the spread
                    without a number on every column. */}
                <LabelList
                  dataKey="netMoic"
                  position="top"
                  fontSize={11}
                  fill={HUE.muted}
                  formatter={(v: any) => multiple(v as number)}
                  content={(props: any) => {
                    const i = props.index as number
                    if (!(data[i]?.isPlan || i === 0 || i === last)) return null
                    return (
                      <text x={props.x + props.width / 2} y={props.y - 4} textAnchor="middle" fontSize={11} fill={data[i]?.isPlan ? HUE.ink : HUE.muted} className="tabular-nums">
                        {multiple(props.value as number)}
                      </text>
                    )
                  }}
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        </>
      )}
    </ChartCard>
  )
}
