// One capital call laid out the way a fund administrator's capital-activity report is (Carta's
// "Capital Activity Detail"). Pure, so the review table and its .xlsx download share it and it can
// be tested without React (components/accounting/call-activity.tsx draws it).

export interface Line { lpEntityId: string; name: string; amount: number; settled: number; advanceApplied?: number; charges?: { amount: number }[] }
export interface Call { id: string; callDate: string; dueDate: string | null; lines: Line[] }
export type IssuedLine = Line & { outstanding: number }
export interface IssuedCall { id: string; callDate: string; dueDate: string | null; lines: IssuedLine[] }
export interface Partner { lpEntityId: string; name: string; commitment: number; called: number | null }

export const HEADERS = ['Investor', 'Commitment', 'Contribution', 'Prepaid Contributions Applied', 'Capital Received', 'Outstanding Balances Applied', 'Other Charges', 'Total Due to Fund', 'Post Call', 'Post Call %']

export function callActivityRows(call: Call, calls: IssuedCall[], partners: Partner[]) {
  const r2 = (n: number) => Math.round(n * 100) / 100
  const later = calls.filter(c => c.callDate > call.callDate || (c.callDate === call.callDate && c.id > call.id))
  const earlier = calls.filter(c => c.id !== call.id && !later.includes(c))
  const sumFor = (list: typeof calls, lp: string, f: (l: IssuedLine) => number) =>
    list.reduce((s, c) => s + c.lines.filter(l => l.lpEntityId === lp).reduce((t, l) => t + f(l), 0), 0)

  const called = new Set(call.lines.map(l => l.lpEntityId))
  const participating = call.lines.map(l => {
    const p = partners.find(x => x.lpEntityId === l.lpEntityId)
    const commitment = p?.commitment ?? 0
    const prepaid = r2(l.advanceApplied ?? 0)
    const received = r2(Math.max(0, l.settled - prepaid))
    const charges = r2((l.charges ?? []).reduce((s, c) => s + c.amount, 0))
    const earlierOutstanding = r2(sumFor(earlier, l.lpEntityId, x => x.outstanding))
    // Called through THIS call: what has been called to date, less any call that came after it.
    const calledThrough = (p?.called ?? 0) - sumFor(later, l.lpEntityId, x => x.amount)
    const postCall = r2(Math.max(0, commitment - calledThrough))
    return {
      name: l.name, commitment, contribution: r2(l.amount), prepaid, received, earlierOutstanding, charges,
      totalDue: r2(l.amount - prepaid + earlierOutstanding + charges),
      postCall, postCallPct: commitment > 0 ? postCall / commitment : null,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const notCalled = partners.filter(p => !called.has(p.lpEntityId) && p.commitment > 0).map(p => p.name).sort((a, b) => a.localeCompare(b))
  return { participating, notCalled }
}
