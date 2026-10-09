'use client'

/**
 * The two partner-capital charts, shared by the Partners page (one row per investor) and the
 * entities overview (one row per vehicle). Same four figures on both pages, so one definition:
 * two copies would end up drawing "called" in two colours.
 *
 *   Called against committed    how much of each commitment has been drawn. The solid bar is
 *                               capital called; the tint it sits in is the commitment, so what
 *                               is left of the tint is what can still be called.
 *   Total value against called  what each has back or still holds (distributions, then NAV),
 *                               with a tick at the capital called. A bar past the tick is ahead;
 *                               short of it, behind. As multiples, the same picture is DPI and
 *                               RVPI against 1.00x, which is what compares positions of
 *                               different sizes.
 *
 * Callers pass the rows already filtered: the charts draw exactly what the table beside them
 * lists, and nothing is fetched here.
 */

import { useState } from 'react'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { CALLED_HUE, ChartCard, HELD_HUE, PROCEEDS_HUE, UNCALLED_HUE } from '@/components/fund-chart-kit'
import { RankedBars } from '@/components/ranked-bars'
import {
  dpi, foldCapital, funded, rvpi, totalValue, tvpi, withCommitment, withMultiple, withValue, type CapitalPosition,
} from '@/lib/charts/capital'
import { othersLabel, wholePercent } from '@/lib/charts/ranked'

type Scale = 'value' | 'multiple'

const multiple = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)

interface CapitalChartsProps {
  positions: CapitalPosition[]
  /** What a row is, plural: "partners", "vehicles". */
  noun: string
  /** Which scale the value chart opens on. Vehicles differ in size by design, so they open on multiples. */
  defaultScale?: Scale
  /** Makes each label a button: the entities overview opens the vehicle. */
  onSelect?: (key: string) => void
  className?: string
}

export function CapitalCharts({ positions, noun, defaultScale = 'value', onSelect, className }: CapitalChartsProps) {
  // One row is a figure, not a comparison: the tiles above already say it.
  if (positions.length < 2) return null
  return (
    <div className={`grid gap-4 lg:grid-cols-2 ${className ?? ''}`}>
      <CalledAgainstCommitted positions={positions} noun={noun} onSelect={onSelect} />
      <ValueAgainstCalled positions={positions} noun={noun} defaultScale={defaultScale} onSelect={onSelect} />
    </div>
  )
}

function CalledAgainstCommitted({ positions, noun, onSelect }: Pick<CapitalChartsProps, 'positions' | 'noun' | 'onSelect'>) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrency(v, currency)
  const fmtFull = (v: number) => formatCurrencyFull(v, currency)
  const items = withCommitment(positions)
  if (items.length === 0) return null

  return (
    <ChartCard title="Called against committed">
      <RankedBars
        items={items}
        rank={p => Math.max(p.committed, p.called)}
        fold={rest => foldCapital(rest, othersLabel(rest.length))}
        noun={noun}
        series={[{ name: 'Called', color: CALLED_HUE }]}
        capacity={{ name: 'Not yet called', color: UNCALLED_HUE }}
        valueHeader="Called"
        noteHeader="Committed"
        row={p => ({
          key: p.key || p.name,
          label: p.name,
          muted: !p.key,
          onSelect: p.key && onSelect ? () => onSelect(p.key) : undefined,
          values: [p.called],
          capacity: p.committed,
          value: fmt(p.called),
          valueTitle: fmtFull(p.called),
          note: fmt(p.committed),
          summary: `${p.name}: ${fmtFull(p.called)} called of ${fmtFull(p.committed)} committed${funded(p) == null ? '' : ` (${wholePercent(funded(p))})`}`,
        })}
      />
    </ChartCard>
  )
}

function ValueAgainstCalled({ positions, noun, defaultScale, onSelect }: CapitalChartsProps) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrency(v, currency)
  const fmtFull = (v: number) => formatCurrencyFull(v, currency)
  const [scale, setScale] = useState<Scale>(defaultScale ?? 'value')

  const byValue = withValue(positions)
  const byMultiple = withMultiple(positions)
  if (byValue.length === 0) return null
  // Nothing called anywhere means there is no multiple to switch to.
  const view: Scale = scale === 'multiple' && byMultiple.length > 0 ? 'multiple' : 'value'

  const toggle = byMultiple.length > 0 ? (
    <div className="inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="Bar scale">
      {(['value', 'multiple'] as const).map(mode => (
        <button
          type="button"
          key={mode}
          aria-pressed={view === mode}
          onClick={() => setScale(mode)}
          className={`px-2 py-1 rounded capitalize ${view === mode ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
        >
          {mode}
        </button>
      ))}
    </div>
  ) : undefined

  return (
    <ChartCard title="Total value against called" action={toggle}>
      <RankedBars
        // The two scales rank differently, so each keeps its own expanded state.
        key={view}
        items={view === 'multiple' ? byMultiple : byValue}
        rank={p => (view === 'multiple' ? tvpi(p) ?? 0 : totalValue(p))}
        fold={rest => foldCapital(rest, othersLabel(rest.length))}
        noun={noun}
        series={[{ name: 'Distributions', color: PROCEEDS_HUE }, { name: 'NAV', color: HELD_HUE }]}
        referenceLabel={view === 'multiple' ? 'Called capital, 1.00x' : 'Called capital'}
        valueHeader="Total value"
        noteHeader="TVPI"
        row={p => ({
          key: p.key || p.name,
          label: p.name,
          muted: !p.key,
          onSelect: p.key && onSelect ? () => onSelect(p.key) : undefined,
          values: view === 'multiple' ? [dpi(p), rvpi(p)] : [p.distributions, p.nav],
          reference: view === 'multiple' ? 1 : p.called,
          value: fmt(totalValue(p)),
          valueTitle: fmtFull(totalValue(p)),
          note: multiple(tvpi(p)),
          summary: `${p.name}: ${fmtFull(p.distributions)} distributed and ${fmtFull(p.nav)} NAV against ${fmtFull(p.called)} called`
            + `${tvpi(p) == null ? '' : `, ${multiple(tvpi(p))} TVPI (${multiple(dpi(p))} DPI, ${multiple(rvpi(p))} RVPI)`}`,
        })}
      />
    </ChartCard>
  )
}
