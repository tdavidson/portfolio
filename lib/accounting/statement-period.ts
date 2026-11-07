// Statement periods for the capital-account roll-forward.
//
// Deliberately NOT tied to `fiscal_periods`: those rows only exist for periods
// someone explicitly CLOSED, so relying on them would mean "this quarter" doesn't
// exist as an option until after you've locked it. These are pure date math and
// always available; a closed fiscal period can be offered alongside them.

export type PeriodPreset = 'this_quarter' | 'last_quarter' | 'ytd' | 'prior_year' | 'itd' | 'custom'

export interface StatementPeriod {
  preset: PeriodPreset
  /** Inclusive; null means "since inception". */
  start: string | null
  /** Inclusive. */
  end: string | null
  label: string
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const q = (month: number) => Math.floor(month / 3) // 0-3

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'prior_year', label: 'Prior year' },
  { value: 'itd', label: 'Inception to date' },
  { value: 'custom', label: 'Custom…' },
]

/** Resolve a preset to a concrete date window, relative to `today`. */
export function resolvePeriod(preset: PeriodPreset, today: Date = new Date()): StatementPeriod {
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()

  switch (preset) {
    case 'this_quarter': {
      const qi = q(m)
      const start = new Date(Date.UTC(y, qi * 3, 1))
      const end = new Date(Date.UTC(y, qi * 3 + 3, 0)) // day 0 of next month = last day of this
      return { preset, start: iso(start), end: iso(end), label: `Q${qi + 1} ${y}` }
    }
    case 'last_quarter': {
      const qi = q(m) - 1
      const ly = qi < 0 ? y - 1 : y
      const lq = qi < 0 ? 3 : qi
      const start = new Date(Date.UTC(ly, lq * 3, 1))
      const end = new Date(Date.UTC(ly, lq * 3 + 3, 0))
      return { preset, start: iso(start), end: iso(end), label: `Q${lq + 1} ${ly}` }
    }
    case 'ytd':
      return { preset, start: iso(new Date(Date.UTC(y, 0, 1))), end: iso(today), label: `YTD ${y}` }
    case 'prior_year':
      return {
        preset,
        start: iso(new Date(Date.UTC(y - 1, 0, 1))),
        end: iso(new Date(Date.UTC(y - 1, 11, 31))),
        label: `FY ${y - 1}`,
      }
    case 'itd':
    default:
      return { preset: 'itd', start: null, end: null, label: 'Inception to date' }
  }
}

/**
 * The year-to-date window for a statement: January 1 of the period end's year (today's, for an
 * open-ended period) through the period end. Always returned, so a statement always has its three
 * columns (statement period, year to date, inception to date): a Q1 or year-to-date statement's YTD
 * column repeats its period column, as a hand-built one does.
 */
export function ytdWindow(
  period: { start?: string | null; end?: string | null } | null | undefined,
  today: Date = new Date(),
): { start: string; end: string } {
  const end = period?.end ?? iso(today)
  return { start: `${end.slice(0, 4)}-01-01`, end }
}

/** Calendar quarter `q` (1-4) of `year`, inclusive. */
export function quarterWindow(year: number, q: number): { start: string; end: string } {
  return { start: iso(new Date(Date.UTC(year, (q - 1) * 3, 1))), end: iso(new Date(Date.UTC(year, q * 3, 0))) }
}

/** "Q1 2026" / "FY 2025" when a window is exactly a calendar quarter or year, else null. */
function calendarLabel(start: string, end: string): string | null {
  const year = Number(start.slice(0, 4))
  if (!Number.isInteger(year) || end.slice(0, 4) !== start.slice(0, 4)) return null
  if (start === `${year}-01-01` && end === `${year}-12-31`) return `FY ${year}`
  for (let q = 1; q <= 4; q++) {
    const w = quarterWindow(year, q)
    if (w.start === start && w.end === end) return `Q${q} ${year}`
  }
  return null
}

/** A custom window, for the explicit start/end date inputs (and the year/quarter picker, which
 *  sends a calendar quarter or year as one and gets its name back as the label). */
export function customPeriod(start: string | null, end: string | null): StatementPeriod {
  return {
    preset: 'custom',
    start: start || null,
    end: end || null,
    label: start && end ? (calendarLabel(start, end) ?? `${start} → ${end}`)
      : end ? `Through ${end}` : start ? `From ${start}` : 'Inception to date',
  }
}

/**
 * One line summarising the period picker's whole state, for its trigger button.
 * `asOf` is appended rather than replacing the window: on the pages that offer it,
 * the preset still bounds the activity and as-of only moves the valuation date.
 */
export function periodTriggerLabel(
  preset: PeriodPreset,
  start: string,
  end: string,
  asOf?: string,
): string {
  const base = preset === 'custom' ? customPeriod(start, end).label : resolvePeriod(preset).label
  return asOf ? `${base} · as of ${asOf}` : base
}

// --- Comparison stepping -----------------------------------------------------

type PeriodInterval = 'quarter' | 'year' | 'ytd' | 'custom-length' | 'none'

function intervalOf(preset: PeriodPreset): PeriodInterval {
  switch (preset) {
    case 'this_quarter':
    case 'last_quarter': return 'quarter'
    case 'prior_year': return 'year'
    case 'ytd': return 'ytd'
    case 'custom': return 'custom-length'
    default: return 'none' // itd
  }
}

const addMonthsUTC = (isoDate: string, months: number): string => {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}
const addDaysUTC = (isoDate: string, days: number): string => {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const daysInclusive = (start: string, end: string): number => {
  const a = new Date(start + 'T00:00:00Z').getTime()
  const b = new Date(end + 'T00:00:00Z').getTime()
  return Math.round((b - a) / 86_400_000) + 1
}
const yearOf = (isoDate: string) => Number(isoDate.slice(0, 4))
const quarterLabel = (start: string) => {
  const month = Number(start.slice(5, 7)) - 1
  return `Q${Math.floor(month / 3) + 1} ${yearOf(start)}`
}

/** The window `k` intervals before `base` (k≥1), or null if base can't be stepped. */
function priorPeriod(base: StatementPeriod, k: number): StatementPeriod | null {
  const kind = intervalOf(base.preset)
  if (!base.start || !base.end) return null
  if (kind === 'quarter') {
    const start = addMonthsUTC(base.start, -3 * k)
    const end = addDaysUTC(addMonthsUTC(start, 3), -1)
    return { preset: base.preset, start, end, label: quarterLabel(start) }
  }
  if (kind === 'year') {
    const start = addMonthsUTC(base.start, -12 * k)
    const end = addDaysUTC(addMonthsUTC(start, 12), -1)
    return { preset: base.preset, start, end, label: `FY ${yearOf(start)}` }
  }
  if (kind === 'ytd') {
    // Whole prior calendar years, not "the same month/day a year ago": a YTD column reads
    // against the full years before it, the way an audited statement presents it. Cutting
    // last year at this year's as-of date compares against a figure nobody has reported.
    const year = yearOf(base.start) - k
    return { preset: 'prior_year', start: `${year}-01-01`, end: `${year}-12-31`, label: `FY ${year}` }
  }
  if (kind === 'custom-length') {
    const len = daysInclusive(base.start, base.end)
    const start = addDaysUTC(base.start, -len * k)
    const end = addDaysUTC(base.end, -len * k)
    return { preset: 'custom', start, end, label: `${start} → ${end}` }
  }
  return null // 'none' (itd)
}

/**
 * Up to `count` prior windows of the same shape as `base`, most-recent-first.
 * Stops once a window ends before `earliest` (the fund's first posting) — that
 * data bound is what "as many periods as exist" means. `count` may be Infinity.
 */
export function comparisonPeriods(
  base: StatementPeriod,
  count: number,
  earliest: string | null,
): StatementPeriod[] {
  if (count <= 0 || !earliest || intervalOf(base.preset) === 'none') return []
  const out: StatementPeriod[] = []
  for (let k = 1; k <= count && out.length < 200; k++) {
    const p = priorPeriod(base, k)
    if (!p || !p.end || p.end < earliest) break
    out.push(p)
  }
  return out
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The calendar months inside `base`, oldest first, each clipped to the window ("Jan 2026", ...).
 * Empty for an open-ended window: a month breakdown needs both ends. Capped at 120 months so a
 * long custom window can't fan out into thousands of payloads.
 */
export function monthlyPeriods(base: StatementPeriod): StatementPeriod[] {
  if (!base.start || !base.end || base.end < base.start) return []
  const out: StatementPeriod[] = []
  let monthStart = `${base.start.slice(0, 7)}-01`
  while (monthStart <= base.end && out.length < 120) {
    const monthEnd = addDaysUTC(addMonthsUTC(monthStart, 1), -1)
    const start = monthStart < base.start ? base.start : monthStart
    const end = monthEnd > base.end ? base.end : monthEnd
    out.push({ preset: 'custom', start, end, label: `${MONTH_NAMES[Number(monthStart.slice(5, 7)) - 1]} ${yearOf(monthStart)}` })
    monthStart = addMonthsUTC(monthStart, 1)
  }
  return out
}
