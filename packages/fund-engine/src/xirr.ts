export interface CashFlow {
  date: Date
  amount: number
}

export function xirr(flows: CashFlow[]): number | null {
  if (flows.length < 2) return null

  // Need at least one positive and one negative cash flow
  const hasPos = flows.some(f => f.amount > 0)
  const hasNeg = flows.some(f => f.amount < 0)
  if (!hasPos || !hasNeg) return null

  // A 365-day year, as Excel's XIRR and fund administrators count it, so a statement agrees with
  // the spreadsheet an investor checks it against. (365.25 read about a basis point higher at 14%.)
  const daysFromFirst = flows.map(f => (f.date.getTime() - flows[0].date.getTime()) / (365 * 86400000))

  // No time spread → IRR is undefined. Every flow is at the same instant, so npv(rate) is the
  // (rate-independent) SUM of the amounts: it has no root in `rate` at all. When that sum is also
  // ~0 (e.g. a single cutover position where NAV = called with no distributions), the Newton loop
  // below sees npv≈0 at its first guess, "accepts" it, and returns that guess (0.1 → a spurious
  // 10%). Bail here instead: you cannot compute a return from a single point in time.
  let minT = daysFromFirst[0], maxT = daysFromFirst[0]
  for (const t of daysFromFirst) { if (t < minT) minT = t; if (t > maxT) maxT = t }
  if (maxT - minT < 1 / 365) return null // under a day of spread

  function npv(rate: number): number {
    return flows.reduce((sum, f, i) => sum + f.amount / Math.pow(1 + rate, daysFromFirst[i]), 0)
  }

  function dnpv(rate: number): number {
    return flows.reduce((sum, f, i) => {
      const t = daysFromFirst[i]
      return sum - t * f.amount / Math.pow(1 + rate, t + 1)
    }, 0)
  }

  // Try multiple starting guesses — a single guess can fail to converge
  // for very high or very low IRRs
  const guesses = [0.1, 0.5, -0.3, -0.5, -0.9, 1.0, 5.0, 10.0, 50.0, 100.0, 0.01]
  const totalAbsFlow = flows.reduce((s, f) => s + Math.abs(f.amount), 0)

  for (const guess of guesses) {
    let rate = guess
    let converged = false
    for (let iter = 0; iter < 200; iter++) {
      const val = npv(rate)
      const deriv = dnpv(rate)
      if (Math.abs(deriv) < 1e-12) break
      const next = rate - val / deriv
      if (Math.abs(next - rate) < 1e-8) {
        rate = next
        converged = true
        break
      }
      rate = next
      if (rate < -0.9999 || rate > 1e6) break
    }
    if (converged || Math.abs(npv(rate)) < Math.max(1, totalAbsFlow * 1e-6)) {
      return rate
    }
  }
  return null
}
