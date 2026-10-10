// The two chart forms the dashboards use, and nothing more general than they need.
//
// Both follow the same rules (DESIGN.md "Categorical" and "Charts"):
//   - one series, one colour: slot 1 of the categorical palette, for every bar and every line.
//     Bars are not shaded by size (length already says it) and a second measure is a neutral
//     mark, not a second hue;
//   - text is ink, never the series colour; a swatch beside the label carries identity;
//   - every value is readable without hovering (a label at the bar's end, the table beneath),
//     and hover or keyboard focus adds a tooltip on top;
//   - one y-axis per chart. Metrics in different units get a chart each, never a second scale.

import { h, svg, clear } from './dom'
import { labelIndexes, lineDomain, linear } from './scale'
import { hideTooltip, showTooltip } from './ui'

// ---------------------------------------------------------------------------------------------
// Horizontal bars, with an optional reference tick (fair value against cost)
// ---------------------------------------------------------------------------------------------

export interface BarDatum {
  label: string
  value: number
  /** A second measure on the same scale, drawn as a thin ink tick across the bar. */
  reference?: number
  /** What the tooltip shows; the value and reference labels are the legend's words. */
  tooltip: { value: string; label: string }[]
  /** The text at the bar's end. */
  valueLabel: string
  onActivate?: () => void
}

export interface BarOptions {
  /** Legend entries. With a reference there are two encodings, so the legend is required. */
  valueName: string
  referenceName?: string
  ariaLabel: string
}

export function barChart(data: BarDatum[], options: BarOptions): HTMLElement {
  const max = Math.max(0, ...data.map(d => Math.max(d.value, d.reference ?? 0)))
  const width = (v: number) => (max > 0 ? `${Math.max(0, Math.min(1, v / max)) * 100}%` : '0%')

  const rows = data.map(d => {
    const activate = d.onActivate
    const row = h('div', {
      class: activate ? 'bar-row bar-row-action' : 'bar-row',
      role: 'listitem',
      tabindex: '0',
      'aria-label': `${d.label}: ${d.tooltip.map(t => `${t.label} ${t.value}`).join(', ')}`,
    },
      h('div', { class: 'bar-label', title: d.label }, d.label),
      h('div', { class: 'bar-track' },
        h('div', { class: 'bar-fill', style: { width: width(d.value) } }),
        typeof d.reference === 'number' && d.reference > 0
          ? h('div', { class: 'bar-tick', style: { left: width(d.reference) } })
          : null,
      ),
      h('div', { class: 'bar-value' }, d.valueLabel),
    )
    const show = (x: number, y: number) => showTooltip(x, y, d.tooltip, d.label)
    row.addEventListener('pointermove', e => show(e.clientX, e.clientY))
    row.addEventListener('pointerleave', hideTooltip)
    row.addEventListener('focus', () => {
      const box = row.getBoundingClientRect()
      show(box.left + box.width / 2, box.top)
    })
    row.addEventListener('blur', hideTooltip)
    if (activate) {
      row.addEventListener('click', activate)
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
      })
    }
    return row
  })

  return h('div', { class: 'chart' },
    options.referenceName
      ? h('div', { class: 'legend' },
          h('span', { class: 'legend-item' }, h('span', { class: 'swatch swatch-bar' }), options.valueName),
          h('span', { class: 'legend-item' }, h('span', { class: 'swatch swatch-tick' }), options.referenceName))
      : null,
    h('div', { class: 'bars', role: 'list', 'aria-label': options.ariaLabel }, rows),
  )
}

// ---------------------------------------------------------------------------------------------
// A single-series line chart, sized to its container
// ---------------------------------------------------------------------------------------------

export interface LinePoint { label: string; value: number }

export interface LineOptions {
  format: (value: number) => string
  /** Compact form for the axis. */
  formatTick: (value: number) => string
  ariaLabel: string
  height?: number
}

const PAD = { top: 12, right: 14, bottom: 22, left: 44 }

/**
 * Draws into `container` and redraws when its width changes. Returns a function that stops
 * observing, for when the view that owns the chart is replaced.
 */
export function lineChart(container: HTMLElement, points: LinePoint[], options: LineOptions): () => void {
  const height = options.height ?? 150
  container.classList.add('line-chart')

  const draw = () => {
    const width = Math.max(180, Math.floor(container.clientWidth))
    clear(container)
    if (points.length === 0) return

    const { ticks, min, max } = lineDomain(points.map(p => p.value))
    const plotW = width - PAD.left - PAD.right
    const plotH = height - PAD.top - PAD.bottom
    const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW)
    const y = linear(min, max, PAD.top + plotH, PAD.top)

    const root = svg('svg', {
      width: String(width), height: String(height), viewBox: `0 0 ${width} ${height}`,
      role: 'img', 'aria-label': options.ariaLabel, tabindex: '0', class: 'line-svg',
    })

    for (const t of ticks) {
      root.appendChild(svg('line', { x1: String(PAD.left), x2: String(width - PAD.right), y1: String(y(t)), y2: String(y(t)), class: 'grid' }))
      root.appendChild(svg('text', { x: String(PAD.left - 6), y: String(y(t)), class: 'tick tick-y' }, options.formatTick(t)))
    }

    // First and last always, and as many between as the width leaves room for.
    for (const i of labelIndexes(points.length, plotW / 64)) {
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'
      root.appendChild(svg('text', { x: String(x(i)), y: String(height - 6), class: 'tick', 'text-anchor': anchor }, points[i].label))
    }

    if (points.length > 1) {
      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
      root.appendChild(svg('path', { d, class: 'line' }))
    }
    // The end point is the one reading every viewer wants; it is marked and the tile above
    // states its value, so no number sits on every point.
    const last = points.length - 1
    root.appendChild(svg('circle', { cx: String(x(last)), cy: String(y(points[last].value)), r: '4', class: 'dot' }))

    const cross = svg('line', { y1: String(PAD.top), y2: String(PAD.top + plotH), class: 'crosshair', visibility: 'hidden' })
    const hover = svg('circle', { r: '4', class: 'dot', visibility: 'hidden' })
    root.appendChild(cross)
    root.appendChild(hover)

    let focused = last
    const point = (i: number) => {
      const cx = x(i), cy = y(points[i].value)
      cross.setAttribute('x1', String(cx)); cross.setAttribute('x2', String(cx))
      cross.setAttribute('visibility', 'visible')
      hover.setAttribute('cx', String(cx)); hover.setAttribute('cy', String(cy))
      hover.setAttribute('visibility', 'visible')
      const box = root.getBoundingClientRect()
      showTooltip(box.left + cx, box.top + cy, [{ value: options.format(points[i].value), label: points[i].label }])
    }
    const leave = () => {
      cross.setAttribute('visibility', 'hidden')
      hover.setAttribute('visibility', 'hidden')
      hideTooltip()
    }
    // The pointer only has to be nearest a reading, never on the 2px line.
    const nearest = (clientX: number) => {
      const box = root.getBoundingClientRect()
      const ratio = points.length === 1 ? 0 : (clientX - box.left - PAD.left) / plotW
      return Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))))
    }
    root.addEventListener('pointermove', e => { focused = nearest(e.clientX); point(focused) })
    root.addEventListener('pointerleave', leave)
    root.addEventListener('focus', () => point(focused))
    root.addEventListener('blur', leave)
    root.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      focused = Math.max(0, Math.min(points.length - 1, focused + (e.key === 'ArrowLeft' ? -1 : 1)))
      point(focused)
    })

    container.appendChild(root)
  }

  draw()
  let lastWidth = container.clientWidth
  const observer = new ResizeObserver(() => {
    if (container.clientWidth === lastWidth) return
    lastWidth = container.clientWidth
    draw()
  })
  observer.observe(container)
  return () => observer.disconnect()
}
