'use client'

/**
 * A ranked list of named things, each drawn as a horizontal bar: holdings by fair value, partners
 * by capital called, vehicles by multiple.
 *
 * This is the row form `TopHoldings` on the fund page already uses, extracted because three more
 * pages now want it — and extended with the two marks that page never needed:
 *
 *   capacity   a lighter bar the solid one sits inside. Called capital inside a commitment: the
 *              solid part is what has been drawn, the tint is what is left to draw.
 *   reference  a tick on the same scale as the bar. Cost against fair value: the bar past the
 *              tick is the markup, the bar short of it the markdown. A stack cannot say that —
 *              it has no way to draw a holding worth less than it cost.
 *
 * Rows are HTML, not Recharts, on purpose. A label on a categorical axis is SVG text: it cannot
 * truncate, cannot be a link, and cannot carry a badge. These rows do all three, and the figures
 * sit beside each bar so nothing has to be hovered to be read.
 *
 * The arithmetic (ranking, folding the tail, bar lengths) is in lib/charts/ranked.ts, where it
 * is tested.
 */

import Link from 'next/link'
import { useState } from 'react'
import { barWidth, topWithOthers } from '@/lib/charts/ranked'

export interface RankedBarSeries {
  name: string
  color: string
}

export interface RankedBarRow {
  key: string
  label: string
  /** Where the label goes when clicked. Omitted for a folded "others" row. */
  href?: string
  onSelect?: () => void
  /** Set on a folded "others" row, which is a remainder rather than a thing with a name. */
  muted?: boolean
  /** A small outlined tag after the label ("Exited"). */
  badge?: string
  /** One value per entry in `series`, in the same order. Stacked left to right. */
  values: (number | null)[]
  capacity?: number | null
  reference?: number | null
  /** The figure beside the bar, already formatted. */
  value: string
  /** The unabbreviated figure, shown on hover of the abbreviated one. */
  valueTitle?: string
  /** A second, quieter figure: a share or a multiple. */
  note?: string
  /** One sentence describing the row, for the bar's hover and for screen readers. */
  summary: string
}

interface RankedBarsProps<T> {
  items: T[]
  /** What a row is ranked by. Largest first. */
  rank: (item: T) => number
  row: (item: T) => RankedBarRow
  /** Combine the rows past `limit` into one. Without it, every row is shown. */
  fold?: (rest: T[]) => T
  limit?: number
  series: RankedBarSeries[]
  /** Legend entry for the tinted bar, and its colour. */
  capacity?: RankedBarSeries
  /** Legend entry for the tick. */
  referenceLabel?: string
  valueHeader: string
  noteHeader?: string
  /**
   * The value the full width of the plot stands for. Defaults to the largest row. Set it when
   * the rows are ratios that should share a round scale.
   */
  scaleMax?: number
  /** What the rows are, plural, for the "Show all 34 holdings" control. */
  noun: string
}

const LABEL_COL = 'w-28 sm:w-40 shrink-0'
const VALUE_COL = 'w-20 sm:w-24 shrink-0 text-right'
const NOTE_COL = 'hidden sm:block w-16 shrink-0 text-right'

function extent(r: RankedBarRow): number {
  const stacked = r.values.reduce<number>((s, v) => s + Math.max(0, v ?? 0), 0)
  return Math.max(stacked, r.capacity ?? 0, r.reference ?? 0)
}

export function RankedBars<T>({
  items, rank, row, fold, limit = 10, series, capacity, referenceLabel, valueHeader, noteHeader, scaleMax, noun,
}: RankedBarsProps<T>) {
  const [expanded, setExpanded] = useState(false)

  const ranked = topWithOthers(items, expanded || !fold ? 0 : limit, rank, fold ?? (rest => rest[0]))
  const rows = ranked.map(row)
  const max = scaleMax ?? rows.reduce((mx, r) => Math.max(mx, extent(r)), 0)
  const folds = !!fold && items.length > limit + 1
  const hasNote = noteHeader != null

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map(s => (
          <span key={s.name} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} /> {s.name}
          </span>
        ))}
        {capacity && (
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: capacity.color }} /> {capacity.name}
          </span>
        )}
        {referenceLabel && (
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 bg-foreground" /> {referenceLabel}
          </span>
        )}
      </div>

      <div className="mb-1 flex items-center gap-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <div className={LABEL_COL} />
        <div className="flex-1 min-w-0" />
        <div className={VALUE_COL}>{valueHeader}</div>
        {hasNote && <div className={NOTE_COL}>{noteHeader}</div>}
      </div>

      <div className="space-y-2">
        {rows.map(r => {
          const segments = series
            .map((s, i) => ({ ...s, value: r.values[i] ?? 0 }))
            .filter(s => s.value > 0)
          return (
            <div key={r.key} className="flex items-center gap-3 text-sm">
              <div className={`${LABEL_COL} flex items-center gap-1.5 min-w-0`} title={r.label}>
                {r.href ? (
                  <Link href={r.href} className="truncate hover:underline">{r.label}</Link>
                ) : r.onSelect ? (
                  <button type="button" onClick={r.onSelect} className="truncate text-left hover:underline">{r.label}</button>
                ) : (
                  <span className={`truncate ${r.muted ? 'text-muted-foreground' : ''}`}>{r.label}</span>
                )}
                {r.badge && (
                  <span className="shrink-0 rounded-sm border px-1 text-[10px] leading-4 text-muted-foreground">{r.badge}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="relative h-4" role="img" aria-label={r.summary} title={r.summary}>
                  {/* With a capacity bar the tint IS the track, so the neutral one is dropped:
                      two pale fills side by side read as two quantities. */}
                  <div className={`absolute inset-0 overflow-hidden rounded-sm ${capacity ? '' : 'bg-muted/50'}`}>
                    {capacity && (
                      <div
                        className="absolute inset-y-0 left-0 rounded-sm"
                        style={{ width: barWidth(r.capacity, max), background: capacity.color }}
                      />
                    )}
                    <div className="absolute inset-0 flex">
                      {segments.map((seg, i) => (
                        <div
                          key={seg.name}
                          className={`h-full ${i < segments.length - 1 ? 'border-r border-background' : ''}`}
                          style={{ width: barWidth(seg.value, max), background: seg.color }}
                        />
                      ))}
                    </div>
                  </div>
                  {/* Outside the clipped track so it can stand a little proud of the bar, with a
                      surface-coloured edge so it stays legible over the fill. */}
                  {referenceLabel && (r.reference ?? 0) > 0 && (
                    <div
                      className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 bg-foreground ring-1 ring-background"
                      style={{ left: barWidth(r.reference, max) }}
                    />
                  )}
                </div>
              </div>
              <div className={`${VALUE_COL} tabular-nums`} title={r.valueTitle}>{r.value}</div>
              {hasNote && <div className={`${NOTE_COL} tabular-nums text-muted-foreground/70`}>{r.note ?? '—'}</div>}
            </div>
          )
        })}
      </div>

      {folds && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          className="mt-3 text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? `Show the largest ${limit}` : `Show all ${items.length} ${noun}`}
        </button>
      )}
    </div>
  )
}
