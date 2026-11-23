import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { buildDistributionWorkbook, distributionWorkbookFileName, type DistributionCalc } from './distribution-workbook'

const calc: DistributionCalc = {
  fundName: 'Example Fund I',
  vehicle: 'Example Fund I',
  source: 'declared',
  date: '2026-06-30',
  description: 'Exit proceeds',
  total: 100_000,
  method: 'waterfall',
  terms: { kind: 'european', carryRate: 0.2, prefRate: 0.08, prefBase: 'contributed', recipients: ['Example GP'] },
  tiers: { returnOfCapital: 65_000, preferred: 4_000, catchUp: 1_000, carry: 19_000, profitToLP: 11_000, toLP: 80_000, toGP: 20_000 },
  stateBefore: { contributed: 200_000, returned: 0 },
  stateAfter: { contributed: 200_000, returned: 65_000 },
  character: { returnOfCapital: 65_000, realizedGain: 35_000, income: 0 },
  lines: [
    { name: 'Acme LP', role: 'lp', amount: 60_000, returnOfCapital: 50_000, preferred: 4_000, profit: 6_000, deductions: 0, paid: 60_000 },
    { name: 'Example GP', role: 'lp', amount: 20_000, returnOfCapital: 15_000, preferred: 0, profit: 5_000 },
    { name: 'Example GP', role: 'carry', amount: 20_000, returnOfCapital: null, preferred: null, profit: null },
  ],
  warnings: [],
  checks: { missing: [], flags: [{ code: 'gp_capital_and_carry', severity: 'warning', message: 'Example GP receives both.' }] },
  signOff: { by: 'jane@fund.example', at: '2026-07-01T10:00:00Z', note: 'Tied to the LPA' },
  generatedAt: '2026-07-01T12:00:00Z',
}

function read(c: DistributionCalc) {
  const wb = XLSX.read(buildDistributionWorkbook(c), { type: 'buffer' })
  return { wb, rows: (name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1 }) }
}

describe('distribution workbook', () => {
  it('has the summary, partner lines, waterfall position and checks', () => {
    expect(read(calc).wb.SheetNames).toEqual(['Summary', 'Partner lines', 'Waterfall position', 'Checks'])
  })

  it('lists the GP\'s capital and its carry as separate lines, and the lines add to the total', () => {
    const rows = read(calc).rows('Partner lines').map(r => r.map(String).join('|'))
    const gp = rows.filter(r => r.startsWith('Example GP'))
    expect(gp).toHaveLength(2)
    expect(gp.some(r => /carr/i.test(r))).toBe(true)
    expect(rows.some(r => r.startsWith('Total') && r.includes('100000'))).toBe(true)
  })

  it('states the sign-off and the checks', () => {
    const { rows } = read(calc)
    const all = [...rows('Summary'), ...rows('Checks')].flat().map(String).join('\n')
    expect(all).toContain('jane@fund.example')
    expect(all).toContain('Example GP receives both.')
  })

  it('says plainly when nobody has signed off, and leaves out the position when there is none', () => {
    const { wb, rows } = read({ ...calc, signOff: null, stateBefore: null, stateAfter: null })
    expect(wb.SheetNames).not.toContain('Waterfall position')
    expect(rows('Summary').flat().map(String).join('\n')).toMatch(/not (yet )?(been )?reviewed|no sign-off/i)
  })

  it('names the file by fund, vehicle, date and whether it is a preview', () => {
    expect(distributionWorkbookFileName('Example Fund I', 'Example Fund I', '2026-06-30', 'preview')).toMatch(/2026-06-30.*preview.*\.xlsx$/i)
  })
})
