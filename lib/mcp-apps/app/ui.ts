// Shared pieces of the dashboard view: KPI tiles, the segmented control, tables, the tooltip.

import { h, clear } from './dom'

export interface Tile {
  label: string
  value: string
  /** Fine print under the figure: a denominator, an "as of", what the ratio is of. */
  sub?: string
  /** A 0..1 share drawn as a meter under the value (called of committed). */
  meter?: number | null
}

/**
 * A row of KPI tiles. The same shape as components/ui/metric.tsx in the app: an eyebrow label
 * over the figure, the figure the largest type in the view, fine print beneath.
 */
export function tiles(items: Tile[]): HTMLElement {
  return h('div', { class: 'tiles' }, items.map(t =>
    h('div', { class: 'tile' },
      h('p', { class: 'eyebrow' }, t.label),
      h('p', { class: 'tile-value' }, t.value),
      typeof t.meter === 'number'
        ? h('div', { class: 'meter', role: 'img', 'aria-label': t.sub ?? t.label },
            h('div', { class: 'meter-fill', style: { width: `${Math.max(0, Math.min(1, t.meter)) * 100}%` } }))
        : null,
      t.sub ? h('p', { class: 'caption' }, t.sub) : null,
    ),
  ))
}

export interface Option<T extends string> { value: T; label: string }

/**
 * Visible options rather than a dropdown: a menu inside an embedded view gets clipped by the
 * host's container, and on a phone it is a second tap for a choice of five.
 */
export function segmented<T extends string>(label: string, options: Option<T>[], current: T | null, onSelect: (value: T) => void): HTMLElement {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label }, options.map(o =>
    h('button', {
      type: 'button',
      class: 'segment',
      'aria-pressed': o.value === current ? 'true' : 'false',
      onclick: () => { if (o.value !== current) onSelect(o.value) },
    }, o.label),
  ))
}

export function button(label: string, onClick: () => void, kind: 'primary' | 'quiet' = 'quiet'): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn btn-${kind}`, onclick: onClick }, label)
}

export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'section' }, h('h2', { class: 'section-title' }, title), children)
}

export function note(text: string, tone: 'muted' | 'warning' = 'muted'): HTMLElement {
  return h('p', { class: tone === 'warning' ? 'note note-warning' : 'note' }, text)
}

export function empty(text: string): HTMLElement {
  return h('div', { class: 'empty' }, text)
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

export interface Column<R> {
  header: string
  /** Right-aligned with tabular figures. */
  numeric?: boolean
  cell: (row: R) => string | Node
  /** Present = the column sorts by this value. */
  sort?: (row: R) => number | string
  /** Hidden below this container width, so a phone gets the columns that matter. */
  minWidth?: 'md' | 'lg'
}

export interface TableOptions<R> {
  caption: string
  /** Called when a row is activated (click, Enter, Space). Makes rows focusable. */
  onRow?: (row: R) => void
  rowLabel?: (row: R) => string
  footer?: (string | Node)[]
  initialSort?: { column: number; descending: boolean }
  limit?: number
}

/** A sortable data table. Headers that sort are buttons; the current order is announced. */
export function dataTable<R>(rows: R[], columns: Column<R>[], options: TableOptions<R>): HTMLElement {
  let sort = options.initialSort ?? null
  const wrap = h('div', { class: 'table-wrap' })

  const draw = () => {
    clear(wrap)
    let ordered = rows.slice()
    if (sort) {
      const key = columns[sort.column].sort
      if (key) {
        const dir = sort.descending ? -1 : 1
        ordered.sort((a, b) => {
          const x = key(a), y = key(b)
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir
        })
      }
    }
    if (options.limit) ordered = ordered.slice(0, options.limit)

    const cls = (c: Column<R>) => [c.numeric ? 'num' : '', c.minWidth ? `hide-below-${c.minWidth}` : ''].filter(Boolean).join(' ') || undefined

    const head = h('tr', null, columns.map((c, i) => {
      const active = sort?.column === i
      const th = h('th', {
        scope: 'col',
        class: cls(c),
        'aria-sort': c.sort ? (active ? (sort!.descending ? 'descending' : 'ascending') : 'none') : undefined,
      })
      if (c.sort) {
        th.appendChild(h('button', {
          type: 'button',
          class: 'th-sort',
          onclick: () => {
            // A number column opens high-to-low, which is the order anyone wants first.
            sort = active ? { column: i, descending: !sort!.descending } : { column: i, descending: !!c.numeric }
            draw()
          },
        },
          // Before the label on a number column, so the label stays flush right over its figures.
          ...(() => {
            const mark = active ? h('span', { class: 'sort-mark', 'aria-hidden': 'true' }, sort!.descending ? '↓' : '↑') : null
            return c.numeric ? [mark, c.header] : [c.header, mark]
          })()))
      } else {
        th.textContent = c.header
      }
      return th
    }))

    const body = ordered.map(row => {
      const tr = h('tr', options.onRow ? {
        class: 'row-action',
        tabindex: '0',
        role: 'button',
        'aria-label': options.rowLabel?.(row),
        onclick: () => options.onRow!(row),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); options.onRow!(row) }
        },
      } : null)
      columns.forEach((c, i) => {
        const cell = c.cell(row)
        tr.appendChild(i === 0 ? h('th', { scope: 'row', class: cls(c) }, cell) : h('td', { class: cls(c) }, cell))
      })
      return tr
    })

    wrap.appendChild(h('table', { class: 'table' },
      h('caption', { class: 'sr-only' }, options.caption),
      h('thead', null, head),
      h('tbody', null, body),
      options.footer
        ? h('tfoot', null, h('tr', null, options.footer.map((f, i) =>
            i === 0 ? h('th', { scope: 'row', class: cls(columns[i]) }, f) : h('td', { class: cls(columns[i]) }, f))))
        : null,
    ))
  }

  draw()
  return wrap
}

// ---------------------------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------------------------

let tip: HTMLElement | null = null

function tipEl(): HTMLElement {
  if (!tip) {
    tip = h('div', { class: 'tooltip', role: 'tooltip', hidden: true })
    document.body.appendChild(tip)
  }
  return tip
}

/**
 * Show the one shared tooltip near a point in the viewport. The value leads and the label
 * follows: by the time someone hovers a mark they know which series it is and want the number.
 */
export function showTooltip(x: number, y: number, rows: { value: string; label: string }[], title?: string): void {
  const el = tipEl()
  clear(el)
  if (title) el.appendChild(h('p', { class: 'tooltip-title' }, title))
  for (const r of rows) {
    el.appendChild(h('p', { class: 'tooltip-row' }, h('strong', null, r.value), ' ', h('span', null, r.label)))
  }
  el.hidden = false
  const box = el.getBoundingClientRect()
  const margin = 8
  const left = Math.max(margin, Math.min(x + 12, window.innerWidth - box.width - margin))
  // Above the pointer when there is room, so the mark being read is not covered.
  const top = y - box.height - 12 >= margin ? y - box.height - 12 : y + 16
  el.style.left = `${left + window.scrollX}px`
  el.style.top = `${top + window.scrollY}px`
}

export function hideTooltip(): void {
  if (tip) tip.hidden = true
}
