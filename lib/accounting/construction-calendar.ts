// The calendar the construction schedule counts years in.
//
// Construction places every deal on a timeline in fractional years from its as-of date. Its yearly
// schedule used to cut that timeline into twelve-month steps from the as-of month, so a schedule
// made in November ran December to November and labelled each step with the year it ended in. The
// plan's statements, Capital planning and the cash-flow chart are calendar years, so the two never
// lined up.
//
// Now the schedule's rows are calendar years. Row 0 is today. Row 1 is what is left of the current
// calendar year (the months after the as-of month through December), unless the as-of month is
// December, when row 1 is the next calendar year. Every later row is a calendar year, and the last
// one stops at the horizon, so it can be part of a year too. Month indexes count months after the
// as-of month: 1 is the month after it.

export interface ScheduleGrid {
  /** YYYY-MM: the as-of month. */
  asOfMonth: string
  /** Months from the as-of month to the end of its calendar year (0 in December). */
  lead: number
  /** Months from the as-of month to the horizon. */
  horizonMonths: number
  /** The last row's index. */
  rows: number
}

export function scheduleGrid(asOf: string, horizonYears: number): ScheduleGrid {
  const asOfMonth = asOf.slice(0, 7)
  const month = Number(asOfMonth.slice(5, 7)) || 12
  const lead = 12 - month
  const horizonMonths = Math.max(1, Math.round(12 * horizonYears))
  const grid = { asOfMonth, lead, horizonMonths, rows: 0 }
  grid.rows = rowOfMonthIndex(grid, horizonMonths)
  return grid
}

/** The month index a fractional time from today falls in (0 for today or earlier). */
export const monthIndexOfTime = (t: number) => (t <= 0 ? 0 : Math.ceil(12 * t - 1e-9))

/** The row a month index falls in, uncapped. */
function rawRow(lead: number, i: number): number {
  if (i <= 0) return 0
  if (lead > 0) return i <= lead ? 1 : 1 + Math.ceil((i - lead) / 12)
  return Math.ceil(i / 12)
}

/** The row a month index falls in; past the horizon, the last row. */
export function rowOfMonthIndex(g: Pick<ScheduleGrid, 'lead'> & Partial<Pick<ScheduleGrid, 'rows'>>, i: number): number {
  const row = rawRow(g.lead, i)
  return g.rows ? Math.min(row, g.rows) : row
}

/** The row a fractional time from today falls in. */
export function rowOfTime(g: ScheduleGrid, t: number): number {
  return rowOfMonthIndex(g, monthIndexOfTime(t))
}

/** The last month index in a row (the horizon for the last row). */
export function rowEndMonth(g: ScheduleGrid, k: number): number {
  if (k <= 0) return 0
  const end = g.lead > 0 ? g.lead + 12 * (k - 1) : 12 * k
  return Math.min(end, g.horizonMonths)
}

/** The first month index in a row. */
export function rowStartMonth(g: ScheduleGrid, k: number): number {
  return k <= 1 ? (k <= 0 ? 0 : 1) : rowEndMonth(g, k - 1) + 1
}

/** Years from today at the end of a row: the time a row's year-end values are measured at. */
export function rowEndTime(g: ScheduleGrid, k: number): number {
  return rowEndMonth(g, k) / 12
}

/** The calendar year a row covers (row 0, today, is the as-of year). */
export function rowCalendarYear(g: ScheduleGrid, k: number): number {
  const year = Number(g.asOfMonth.slice(0, 4))
  if (k <= 0) return year
  return g.lead > 0 ? year + k - 1 : year + k
}

/**
 * Spread figures stated per forward year (year y = months 12y−11 … 12y after the as-of month)
 * evenly over their months and add them up by row. `perYear[0]` is ignored.
 */
export function forwardYearsToRows(g: ScheduleGrid, perYear: number[]): number[] {
  const out = new Array<number>(g.rows + 1).fill(0)
  for (let i = 1; i <= g.horizonMonths; i++) {
    const v = perYear[Math.ceil(i / 12)] ?? 0
    if (v) out[rowOfMonthIndex(g, i)] += v / 12
  }
  return out.map(v => Math.round(v * 100) / 100)
}
