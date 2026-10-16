import { describe, it, expect } from 'vitest'
import { buildStatementHtml, NET_PNL_LABEL, type StatementPdfData } from './lp-statement-pdf'
import { ytdWindow } from './statement-period'
import { emptyAccount, type CapitalAccount } from './capital-account'

// An illustrative partner's books, inception to date.
const itd: CapitalAccount = {
  ...emptyAccount(),
  contributions: 80000, managementFees: -8000, expenses: -4000,
  operatingIncome: 1500, realizedGains: 200, ending: 69700,
}

function data(over: Partial<StatementPdfData> = {}): StatementPdfData {
  return {
    fundName: 'Example Capital', fundLogo: null, fundAddress: null, currency: 'USD',
    vehicle: 'Example Fund LP', partnerName: 'Partner A',
    period: { label: 'Inception to date', start: null, end: null } as any,
    row: { commitment: 100000, called: 80000, funded: 80000, outstanding: 20000, receivable: 0, ending: 69700 },
    periodRollForward: itd, ytdRollForward: itd, rollForward: itd, ownership: 0.025,
    ...over,
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('buildStatementHtml', () => {
  it('shows beginning, management fees, net profit or loss, ending capital and the commitment', () => {
    const t = text(buildStatementHtml(data()))
    expect(t).toContain('Beginning capital')
    expect(t).toContain('Management fees ($8,000.00)')
    // -8000 - 4000 + 1500 + 200
    expect(t).toContain(`${NET_PNL_LABEL} ($10,300.00)`)
    expect(t).toContain('Ending capital $69,700.00')
    expect(t).toContain('Commitment $100,000.00')
  })

  it('keeps the rows outside the profit and loss block summing to ending capital', () => {
    // beginning + contributions + net P&L = ending; the components are indented under the subtotal.
    expect(0 + 80000 - 10300).toBeCloseTo(itd.ending, 2)
    const html = buildStatementHtml(data())
    expect(html.indexOf('Contributions')).toBeLessThan(html.indexOf('Management fees'))
    expect(html.indexOf('Net realized gain')).toBeLessThan(html.indexOf(NET_PNL_LABEL))
    expect(html.indexOf(NET_PNL_LABEL)).toBeLessThan(html.indexOf('Ending capital'))
  })

  it('leaves the subtotal out when nothing in the period is profit or loss', () => {
    const flat = { ...emptyAccount(), contributions: 5000, ending: 5000 }
    expect(buildStatementHtml(data({ periodRollForward: flat, ytdRollForward: flat, rollForward: flat }))).not.toContain(NET_PNL_LABEL)
  })

  it("puts the vehicle's logo in the header when one is passed", () => {
    expect(buildStatementHtml(data({ fundLogo: 'data:image/png;base64,EXF' }))).toContain('src="data:image/png;base64,EXF"')
  })

  it('prints all three columns for a Q2 statement, and lays the commitment summary out in them', () => {
    const quarter = { ...emptyAccount(), beginning: 68900, operatingIncome: 240, ending: 69140 }
    const ytd = { ...emptyAccount(), beginning: 68000, operatingIncome: 1140, ending: 69140 }
    const t = text(buildStatementHtml(data({
      period: { label: 'Q2 2026', start: '2026-04-01', end: '2026-06-30' } as any,
      periodRollForward: quarter, ytdRollForward: ytd,
    })))
    expect(t).toContain('Statement period Year to date Inception to date')
    expect(t).toContain('Ending capital $69,140.00 $69,140.00 $69,700.00')
    // Called capital is a flow (nothing called this quarter); the balances sit under inception to date.
    expect(t).toContain('Called capital — — $80,000.00')
    expect(t).toContain('Remaining to be called $20,000.00')
    expect(t).toContain('unaudited')
  })

  it('drops the year-to-date column when the period is year to date (Q1, or the YTD preset)', () => {
    const q1 = { ...emptyAccount(), beginning: 68900, operatingIncome: 240, ending: 69140 }
    for (const period of [
      { label: 'Q1 2026', start: '2026-01-01', end: '2026-03-31' },
      { preset: 'ytd', label: 'YTD 2026', start: '2026-01-01', end: '2026-10-13' },
    ]) {
      const t = text(buildStatementHtml(data({ period: period as any, periodRollForward: q1, ytdRollForward: q1 })))
      expect(t).toContain('Statement period Inception to date')
      expect(t).not.toContain('Year to date')
      expect(t).toContain('Ending capital $69,140.00 $69,700.00 ')
    }
  })

  it('drops the statement-period column on an inception-to-date statement', () => {
    const ytd = { ...emptyAccount(), beginning: 68900, operatingIncome: 240, ending: 69140 }
    const t = text(buildStatementHtml(data({ ytdRollForward: ytd })))
    expect(t).not.toContain('Statement period')
    expect(t).toContain('Year to date Inception to date')
    expect(t).toContain('Ending capital $69,140.00 $69,700.00 ')
    expect(t).toContain('Called capital — $80,000.00')
  })

  it('ends at the commitment summary', () => {
    const t = text(buildStatementHtml(data()))
    expect(t).toContain('Commitment summary')
    for (const gone of ['Contributions and distributions in the period', 'Commitments to underlying funds', 'Underlying fund performance', 'Basis of valuation']) {
      expect(t).not.toContain(gone)
    }
  })
})

describe('ytdWindow', () => {
  const today = new Date('2026-10-13T00:00:00Z')
  it('runs from January 1 of the period end year to the period end', () => {
    expect(ytdWindow({ start: '2026-04-01', end: '2026-06-30' }, today))
      .toEqual({ start: '2026-01-01', end: '2026-06-30' })
  })
  it('repeats the period for a Q1 or year-to-date statement', () => {
    expect(ytdWindow({ start: '2026-01-01', end: '2026-03-31' }, today))
      .toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(ytdWindow({ start: '2026-01-01', end: '2026-10-13' }, today))
      .toEqual({ start: '2026-01-01', end: '2026-10-13' })
  })
  it('ends today for an inception-to-date statement', () => {
    expect(ytdWindow({ start: null, end: null }, today))
      .toEqual({ start: '2026-01-01', end: '2026-10-13' })
    expect(ytdWindow(undefined, today))
      .toEqual({ start: '2026-01-01', end: '2026-10-13' })
  })
})
