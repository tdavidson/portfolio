'use client'

/**
 * The shared vocabulary for fund charts — the card, the axis/tooltip styling, and the palette.
 *
 * These lived as module-private constants inside fund-detail-view.tsx, which was fine while that
 * page was the only one plotting anything. Portfolio construction plots the same quantities
 * (invested capital, proceeds, gains) and would otherwise pick its own hues for them, so the two
 * pages would drift into saying "invested capital" in two colours. Extracted rather than copied:
 * one definition is the only way that stays true.
 *
 * The palette itself is NOT chosen here — it is the app's categorical ramp from globals.css,
 * validated with the dataviz checker against both surfaces. Read the note above `--cat-1` there
 * before adding a slot: the adjacent pairlist (stacks, bars) clears all eight, but all-pairs
 * forms (pie, scatter) clear only four, which is why `SLICE` is four long and folds to muted.
 */

import { Card, CardContent } from '@/components/ui/card'

export function ChartCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4 px-4">
        {/* As tall as a segmented toggle whether or not the card has one, so two cards side by
            side start their plots on the same line. */}
        <div className="flex min-h-[30px] items-center justify-between gap-2 mb-3">
          <p className="text-sm font-medium">{title}</p>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

export function EmptyPlot({ label }: { label: string }) {
  return <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">{label}</div>
}

export const AXIS = { fontSize: 11 } as const

export const tooltipStyle = {
  borderRadius: '6px',
  border: '1px solid hsl(var(--border))',
  backgroundColor: 'hsl(var(--popover))',
  color: 'hsl(var(--popover-foreground))',
  fontSize: '12px',
} as const

// Categorical hues, assigned in FIXED order from the theme's chart ramp (never cycled).
export const HUE = {
  chart1: 'hsl(var(--chart-1))',
  chart2: 'hsl(var(--chart-2))',
  chart3: 'hsl(var(--chart-3))',
  chart4: 'hsl(var(--chart-4))',
  chart5: 'hsl(var(--chart-5))',
  ink: 'hsl(var(--foreground))',
  muted: 'hsl(var(--muted-foreground))',
  surface: 'hsl(var(--background))',
}

// Pie slices sit side by side in every combination, so they need the ALL-PAIRS
// palette, not the adjacent-pairs one the stacked bars use. Only four slots clear
// that bar in both light and dark (see the note in globals.css) — hence four
// categorical hues and then "Other" in muted ink. Fixed order, never cycled: a
// slice keeps its colour as the mix changes.
export const SLICE = ['hsl(var(--cat-1))', 'hsl(var(--cat-4))', 'hsl(var(--cat-5))', 'hsl(var(--cat-6))']
export const sliceFill = (i: number) => SLICE[i] ?? HUE.muted

// Invested capital reads as one hue split by intensity: new = solid, follow-on = a
// lighter tint of the same slot (so the pairing holds in either theme). Gains and
// proceeds take their own slots, distinct from it and from each other.
export const INVEST_NEW = HUE.chart3
export const INVEST_FOLLOW = 'hsl(var(--chart-3) / 0.5)'
export const GAINS_HUE = HUE.chart1
export const PROCEEDS_HUE = HUE.chart2

// Called capital is the same money as invested capital seen from the partners' side, so it takes
// the same slot. What is committed but not yet called is a tint of it: the two together are the
// commitment, and a tint reads as "the rest of this" where a second hue would read as a second
// thing. Lighter than INVEST_FOLLOW because it sits directly against the solid, not in a stack.
export const CALLED_HUE = HUE.chart3
export const UNCALLED_HUE = 'hsl(var(--chart-3) / 0.35)'
// What is still held, at fair value: the slot unrealized gains already use, since on every
// chart that plots both, the held value is the bar those gains are the visible part of.
export const HELD_HUE = HUE.chart1
