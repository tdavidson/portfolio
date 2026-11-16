'use client'

/**
 * Chart primitives, after shadcn/ui's `chart` component, on the Recharts the app already uses.
 *
 * Every chart in the app goes through these three pieces, so a chart looks like the others without
 * restating its axis, grid, tooltip and legend styling:
 *
 * - `ChartContainer` sizes the plot, publishes each config entry's colour as `--color-<key>`, and
 *   styles Recharts' own SVG (muted tick text, hairline horizontal grid, muted cursor, no focus
 *   outline) from the theme tokens, so light and dark follow the same variables.
 * - `ChartTooltipContent` is the one tooltip: a label, then a row per series with its colour
 *   indicator, its name and a right-aligned tabular figure.
 * - `ChartLegendContent` is the one legend: the dot the app's row charts already use (a short line
 *   for a line series, dashed when the series is) and muted text, above the plot at the left, where
 *   the hand-built legends on the ranked-bar charts sit. Pass `verticalAlign="top" align="left"` to
 *   `<ChartLegend>` so Recharts reserves the room for it.
 *
 * Config is optional. Where a chart passes none, names and colours come from the Recharts items
 * (`name`, `fill`/`stroke`), so a chart can adopt the container, tooltip and legend without first
 * restating every series. A chart's existing `formatter`/`labelFormatter` on `<ChartTooltip>` keep
 * working: a formatter that returns `[value, name]` (the Recharts convention) is honoured.
 */

import * as React from 'react'
import * as RechartsPrimitive from 'recharts'

import { cn } from '@/lib/utils'

export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string; icon?: React.ComponentType }>

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null)

function useChart() {
  return React.useContext(ChartContext) ?? { config: {} as ChartConfig }
}

/**
 * Recharts draws its grid, ticks, cursor and sectors with literal colours and focus outlines; these
 * rules repoint every one of them at the theme, the way shadcn's container does. Grid lines are a
 * solid hairline whatever `strokeDasharray` a chart still passes.
 */
const CHART_SURFACE = [
  'text-xs',
  '[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground',
  '[&_.recharts-cartesian-grid_line]:stroke-border',
  '[&_.recharts-cartesian-grid_line]:[stroke-dasharray:0]',
  '[&_.recharts-polar-grid_[stroke]]:stroke-border',
  '[&_.recharts-curve.recharts-tooltip-cursor]:stroke-border',
  '[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/60',
  '[&_.recharts-dot[stroke="#fff"]]:stroke-transparent',
  '[&_.recharts-sector[stroke="#fff"]]:stroke-card',
  '[&_.recharts-layer]:outline-none',
  '[&_.recharts-sector]:outline-none',
  '[&_.recharts-surface]:outline-none',
].join(' ')

export function ChartContainer({
  id,
  config = {},
  height,
  className,
  style,
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  config?: ChartConfig
  /** Plot height in px. Omit to size from `className` (e.g. `h-[240px]`). */
  height?: number
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${(id ?? uniqueId).replace(/:/g, '')}`
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn('relative w-full', CHART_SURFACE, className)}
        style={height != null ? { height, ...style } : style}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const entries = Object.entries(config).filter(([, c]) => c.color)
  if (!entries.length) return null
  const vars = entries.map(([key, c]) => `  --color-${key}: ${c.color};`).join('\n')
  return <style dangerouslySetInnerHTML={{ __html: `[data-chart=${id}] {\n${vars}\n}` }} />
}

export const ChartTooltip = RechartsPrimitive.Tooltip

type Item = {
  name?: string | number
  dataKey?: string | number | ((row: unknown) => unknown)
  value?: unknown
  color?: string
  fill?: string
  stroke?: string
  type?: string
  payload?: Record<string, unknown>
  strokeDasharray?: string | number
}

type Formatter = (value: any, name: any, item: any, index: number, payload: any) => React.ReactNode | [React.ReactNode, React.ReactNode]

function keyOf(item: Item, nameKey?: string): string {
  if (nameKey && item.payload && typeof item.payload[nameKey] === 'string') return item.payload[nameKey] as string
  if (typeof item.dataKey === 'string') return item.dataKey
  return String(item.name ?? '')
}

/** The colour a series is drawn in: its config entry, else what Recharts drew it with. */
function colourOf(item: Item, configured?: string): string | undefined {
  if (configured) return configured
  const fromPayload = item.payload && (item.payload.fill as string | undefined)
  // A Cell-coloured bar or slice carries its own fill on the row.
  return item.color ?? fromPayload ?? item.fill ?? item.stroke
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  formatter,
  valueFormatter,
  hideLabel = false,
  hideIndicator = false,
  indicator = 'dot',
  nameKey,
  className,
}: {
  active?: boolean
  payload?: readonly Item[]
  label?: React.ReactNode
  labelFormatter?: (label: any, payload: any) => React.ReactNode
  formatter?: Formatter
  /** Formats each value, keeping the row's indicator and name. */
  valueFormatter?: (value: number, name: string, item: Item) => React.ReactNode
  hideLabel?: boolean
  hideIndicator?: boolean
  indicator?: 'dot' | 'line' | 'dashed'
  nameKey?: string
  className?: string
}) {
  const { config } = useChart()
  if (!active || !payload?.length) return null
  // A band drawn as a transparent base plus a spread, or any series a chart hides from the
  // tooltip, arrives with tooltipType 'none'; Recharts already drops those, and null values carry
  // nothing to read.
  const rows = payload.filter(item => item.value != null && (item as { type?: string }).type !== 'none')
  if (!rows.length) return null

  const heading = hideLabel ? null : labelFormatter ? labelFormatter(label, payload) : label
  return (
    <div className={cn('grid min-w-[9rem] gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md', className)}>
      {heading != null && heading !== '' && <div className="font-medium">{heading}</div>}
      <div className="grid gap-1">
        {rows.map((item, index) => {
          const key = keyOf(item, nameKey)
          const entry = config[key]
          const colour = colourOf(item, entry?.color ? `var(--color-${key})` : undefined)
          let value: React.ReactNode = typeof item.value === 'number' ? item.value.toLocaleString() : String(item.value)
          let name: React.ReactNode = entry?.label ?? item.name ?? key
          if (formatter) {
            const out = formatter(item.value, item.name, item, index, item.payload)
            if (Array.isArray(out)) {
              value = out[0]
              if (out[1] != null) name = out[1]
            } else {
              value = out
            }
          } else if (valueFormatter && typeof item.value === 'number') {
            value = valueFormatter(item.value, String(item.name ?? key), item)
          }
          return (
            <div key={`${key}-${index}`} className="flex items-center gap-2">
              {!hideIndicator && (
                <span
                  aria-hidden
                  className={cn(
                    'shrink-0',
                    indicator === 'dot' && 'h-2.5 w-2.5 rounded-full',
                    indicator === 'line' && 'h-0.5 w-3',
                    indicator === 'dashed' && 'h-0 w-3 border-t-2 border-dashed bg-transparent',
                  )}
                  style={indicator === 'dashed' ? { borderColor: colour } : { backgroundColor: colour }}
                />
              )}
              <span className="text-muted-foreground">{name}</span>
              <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">{value}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const ChartLegend = RechartsPrimitive.Legend

type LegendItem = {
  value?: React.ReactNode
  dataKey?: string | number | ((row: unknown) => unknown)
  color?: string
  type?: string
  inactive?: boolean
  payload?: { strokeDasharray?: string | number; fill?: string; stroke?: string }
}

export function ChartLegendContent({
  payload,
  nameKey,
  className,
}: {
  payload?: readonly LegendItem[]
  nameKey?: string
  className?: string
}) {
  const { config } = useChart()
  const items = (payload ?? []).filter(item => item.type !== 'none')
  if (!items.length) return null
  return (
    <div className={cn('flex flex-wrap items-center justify-start gap-x-4 gap-y-1 pb-3 text-xs text-muted-foreground', className)}>
      {items.map((item, index) => {
        const key = nameKey && item.payload ? String((item.payload as Record<string, unknown>)[nameKey] ?? '') : typeof item.dataKey === 'string' ? item.dataKey : String(item.value ?? '')
        const entry = config[key]
        const colour = entry?.color ? `var(--color-${key})` : item.color
        const isLine = item.type === 'line' || item.type === 'plainline'
        const dashed = isLine && item.payload?.strokeDasharray != null && String(item.payload.strokeDasharray) !== '0'
        return (
          <div key={`${key}-${index}`} className={cn('flex items-center gap-1.5', item.inactive && 'opacity-50')}>
            {isLine ? (
              <span aria-hidden className={cn('h-0 w-3 shrink-0 border-t-2', dashed && 'border-dashed')} style={{ borderColor: colour }} />
            ) : (
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
            )}
            <span>{entry?.label ?? item.value}</span>
          </div>
        )
      })}
    </div>
  )
}
