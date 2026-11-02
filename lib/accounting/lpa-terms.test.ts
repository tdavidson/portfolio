import { describe, it, expect } from 'vitest'
import {
  extractJsonObject, heuristicLpaTerms, parseLpaTermsResponse, passagesOf, proposalToTermsInput, rateFraction,
  relevantPassages, sourcesOf, verifyQuote, buildLpaTermsPrompt,
} from './lpa-terms'
import { NO_CARRY, type VehicleCarryTerms } from './carry'
import { parseWaterfallTermsInput } from './waterfall-terms'
import { describeTerms } from '@/lib/pending-actions/waterfall-terms'

// A made-up agreement: no real fund, firm or figures.
const LPA = `[Page 1]
LIMITED PARTNERSHIP AGREEMENT OF EXAMPLE VENTURES FUND LP

[Page 14]
Section 4.1 Management Fee
The Partnership shall pay the Manager an annual management fee equal to two percent (2%) of the aggregate Capital Commitments, payable quarterly in advance.

[Page 22]
Section 6.2 Distributions
Distributable proceeds shall be distributed as follows:
(i) first, 100% to the Limited Partners until they have received cumulative distributions equal to their aggregate Capital Contributions;
(ii) second, 100% to the Limited Partners until they have received a preferred return of eight percent (8%) per annum, compounded annually, on such Capital Contributions;
(iii) third, a catch-up, 100% to the General Partner until the General Partner has received 20% of the aggregate amounts distributed under clause (ii) and this clause (iii);
(iv) thereafter, 80% to the Limited Partners and 20% to the General Partner.

Section 6.5 General Partner Clawback
Upon the dissolution of the Partnership, the General Partner shall return to the Partnership any distributions of carried interest in excess of the amount it would have received.
`

describe('passagesOf', () => {
  it('tags each paragraph with its page and section', () => {
    const ps = passagesOf(LPA)
    const fee = ps.find(p => /annual management fee/.test(p.text))!
    expect(fee.page).toBe(14)
    expect(fee.section).toBe('Section 4.1 Management Fee')
    const split = ps.find(p => /thereafter, 80%/.test(p.text))!
    expect(split.page).toBe(22)
    expect(split.section).toBe('Section 6.2 Distributions')
  })

  it('relevantPassages keeps the waterfall and fee clauses in document order, within the budget', () => {
    const ps = relevantPassages(LPA, 100_000)
    expect(ps.some(p => /catch-up/.test(p.text))).toBe(true)
    expect(ps.some(p => /management fee/.test(p.text))).toBe(true)
    expect(ps.findIndex(p => /management fee/.test(p.text))).toBeLessThan(ps.findIndex(p => /catch-up/.test(p.text)))
    expect(relevantPassages(LPA, 50)).toEqual([])
  })
})

describe('heuristicLpaTerms', () => {
  const p = heuristicLpaTerms(LPA)

  it('reads a European waterfall: 20% carry, 8% compounding pref, full catch-up', () => {
    expect(p.method).toBe('heuristic')
    expect(p.terms.kind?.value).toBe('european')
    expect(p.terms.carryRate?.value).toBe(0.2)
    expect(p.terms.carryRate?.quote).toMatch(/20% to the General Partner/)
    expect(p.terms.carryRate?.page).toBe(22)
    expect(p.terms.prefRate?.value).toBe(0.08)
    expect(p.terms.prefCompounds?.value).toBe(true)
    expect(p.terms.catchupRate?.value).toBe(1)
    // "on such Capital Contributions" is how both hurdle bases are written, so it is not guessed.
    expect(p.notFound).toEqual(['prefBase'])
  })

  it('reads a hurdle on unreturned capital', () => {
    const unreturned = LPA.replace('compounded annually, on such Capital Contributions', 'compounded annually, on their unreturned Capital Contributions')
    const q = heuristicLpaTerms(unreturned)
    expect(q.terms.prefBase).toMatchObject({ value: 'unreturned', confidence: 'medium' })
    expect(q.unsupported.map(u => u.provision).join(' ')).not.toMatch(/unreturned/i)
  })

  it('never claims high confidence', () => {
    for (const f of Object.values(p.terms)) expect(f!.confidence).not.toBe('high')
  })

  it('reads the management fee for the record', () => {
    expect(p.info.managementFeeRate?.value).toBe(0.02)
    expect(p.info.managementFeeBasis?.value).toBe('committed')
  })

  it('flags a clawback as unsupported, with its clause', () => {
    const claw = p.unsupported.find(u => /clawback/i.test(u.provision))!
    expect(claw.section).toBe('Section 6.5 General Partner Clawback')
    expect(claw.quote).toMatch(/shall return to the Partnership/)
  })

  it('reads an 80/20 partial catch-up as 0.8', () => {
    const partial = LPA.replace('a catch-up, 100% to the General Partner', 'a catch-up, 80% to the General Partner and 20% to the Limited Partners')
    expect(heuristicLpaTerms(partial).terms.catchupRate?.value).toBe(0.8)
  })

  it('reads a simple hurdle as not compounding', () => {
    const simple = LPA.replace('per annum, compounded annually,', 'per annum, calculated on a simple basis and not compounded,')
    expect(heuristicLpaTerms(simple).terms.prefCompounds?.value).toBe(false)
  })

  it('reads carry with no hurdle as straight, and does not ask for a hurdle', () => {
    const straight = `[Page 3]\nSection 5 Carried Interest\nAfter the return of all Capital Contributions, the remainder shall be distributed 80% to the Members and 20% to the Manager as carried interest.`
    const s = heuristicLpaTerms(straight)
    expect(s.terms.kind?.value).toBe('straight')
    expect(s.terms.carryRate?.value).toBe(0.2)
    expect(s.notFound).not.toContain('prefRate')
    expect(s.notFound).not.toContain('catchupRate')
  })

  it('reads deal-by-deal language as american', () => {
    const american = LPA.replace('Distributable proceeds shall be distributed as follows:', 'Proceeds shall be distributed on a deal-by-deal basis as follows:')
    expect(heuristicLpaTerms(american).terms.kind?.value).toBe('american')
  })

  it('lists what it cannot find, and warns when nothing mentions carry', () => {
    const none = heuristicLpaTerms('[Page 1]\nThe Partnership shall keep books at its principal office.')
    expect(none.notFound).toEqual(['kind', 'carryRate', 'prefRate', 'prefCompounds', 'prefBase', 'catchupRate', 'managementFeeRate', 'managementFeeBasis'])
    expect(none.warnings.join(' ')).toMatch(/No clause mentions carried interest/)
  })
})

describe('verifyQuote', () => {
  it('ignores whitespace, case, page breaks and typographic quotes', () => {
    expect(verifyQuote('THEREAFTER,   80% to the Limited Partners and 20% to the General Partner', LPA)).toBe(true)
    expect(verifyQuote('the “Partnership” shall pay', 'The "Partnership" shall pay the Manager')).toBe(true)
    expect(verifyQuote('received a preferred return of eight percent (8%) per annum', LPA.replace('received a preferred', 'received a\n[Page 23]\npreferred'))).toBe(true)
  })

  it('accepts an ellipsis only when every piece is there, in order', () => {
    expect(verifyQuote('a catch-up, 100% to the General Partner ... clause (ii) and this clause (iii)', LPA)).toBe(true)
    expect(verifyQuote('clause (ii) and this clause (iii) ... a catch-up, 100% to the General Partner', LPA)).toBe(false)
  })

  it('rejects words the document does not contain, and quotes too short to mean anything', () => {
    expect(verifyQuote('25% to the General Partner as carried interest', LPA)).toBe(false)
    expect(verifyQuote('8%', LPA)).toBe(false)
  })
})

describe('rateFraction', () => {
  it('takes fractions, percents and percent strings', () => {
    expect(rateFraction(0.2, 'carryRate')).toBe(0.2)
    expect(rateFraction(20, 'carryRate')).toBe(0.2)
    expect(rateFraction('8%', 'prefRate')).toBe(0.08)
    expect(rateFraction('0.08', 'prefRate')).toBe(0.08)
  })
  it('reads 1 as 100% for the catch-up and as 1% otherwise', () => {
    expect(rateFraction(1, 'catchupRate')).toBe(1)
    expect(rateFraction(80, 'catchupRate')).toBe(0.8)
    expect(rateFraction(1, 'carryRate')).toBe(0.01)
  })
  it('refuses nonsense', () => {
    expect(rateFraction(-0.1, 'carryRate')).toBeNull()
    expect(rateFraction(250, 'carryRate')).toBeNull()
    expect(rateFraction('twenty', 'carryRate')).toBeNull()
    expect(rateFraction(null, 'carryRate')).toBeNull()
  })
})

describe('parseLpaTermsResponse', () => {
  const good = {
    kind: { value: 'european', quote: 'Distributable proceeds shall be distributed as follows:', confidence: 'high' },
    carryRate: { value: 20, quote: 'thereafter, 80% to the Limited Partners and 20% to the General Partner', section: 'Section 6.2', page: 22, confidence: 'high' },
    prefRate: { value: 0.08, quote: 'a preferred return of eight percent (8%) per annum, compounded annually', confidence: 'high' },
    prefCompounds: { value: true, quote: 'compounded annually, on such Capital Contributions', confidence: 'high' },
    catchupRate: { value: 1.0, quote: '100% to the General Partner until the General Partner has received 20%', confidence: 'high' },
    managementFeeRate: { value: '2%', quote: 'two percent (2%) of the aggregate Capital Commitments', confidence: 'high' },
    managementFeeBasis: { value: 'committed', quote: 'two percent (2%) of the aggregate Capital Commitments', confidence: 'high' },
    unsupported: [],
    notes: ['Clause (iii) is a full catch-up.'],
  }

  it('accepts a verified reading, normalising percents and filling the location from the text', () => {
    const p = parseLpaTermsResponse(good, LPA, 'server_model')
    expect(p.method).toBe('server_model')
    expect(p.terms.carryRate).toMatchObject({ value: 0.2, confidence: 'high', quoteVerified: true, section: 'Section 6.2', page: 22 })
    expect(p.terms.prefRate).toMatchObject({ value: 0.08, quoteVerified: true, page: 22, section: 'Section 6.2 Distributions' })
    expect(p.info.managementFeeRate?.value).toBe(0.02)
    expect(p.notFound).toEqual(['prefBase'])
    expect(p.warnings).toContain('Clause (iii) is a full catch-up.')
    // The reader did not mention the clawback; the pattern check adds it.
    expect(p.unsupported.map(u => u.provision).join(' ')).toMatch(/clawback/i)
  })

  it('takes JSON wrapped in a code fence or prose', () => {
    const raw = 'Here you go:\n```json\n' + JSON.stringify(good) + '\n```'
    expect(parseLpaTermsResponse(raw, LPA, 'server_model').terms.kind?.value).toBe('european')
    expect(extractJsonObject('prefix {"a":1} suffix')).toEqual({ a: 1 })
    expect(() => extractJsonObject('no json here')).toThrow(/No JSON/)
  })

  it('caps a quote not found in the document at low confidence, and says so', () => {
    const p = parseLpaTermsResponse({ ...good, carryRate: { value: 0.25, quote: '25% to the General Partner as its carried interest', confidence: 'high' } }, LPA, 'assistant')
    expect(p.terms.carryRate).toMatchObject({ value: 0.25, confidence: 'low', quoteVerified: false })
    expect(p.terms.carryRate?.note).toMatch(/not found in the document/)
  })

  it('drops a field with no quote, a bad value or one out of range, to notFound with a warning', () => {
    const p = parseLpaTermsResponse({
      ...good,
      kind: { value: 'bespoke', quote: 'Distributable proceeds shall be distributed as follows:' },
      carryRate: { value: 0.2 },
      catchupRate: { value: 150, quote: '100% to the General Partner until' },
      prefRate: 'eight',
    }, LPA, 'assistant')
    expect(p.terms.kind).toBeUndefined()
    expect(p.terms.carryRate).toBeUndefined()
    expect(p.terms.catchupRate).toBeUndefined()
    expect(p.terms.prefRate).toBeUndefined()
    expect(p.notFound).toEqual(expect.arrayContaining(['kind', 'carryRate', 'catchupRate', 'prefRate']))
    const w = p.warnings.join('\n')
    expect(w).toMatch(/kind: "bespoke" is not a valid value/)
    expect(w).toMatch(/carryRate: no quote given/)
    expect(w).toMatch(/catchupRate: 150 is not a valid value/)
    expect(w).toMatch(/prefRate: expected an object/)
  })

  it('treats null as not found, and refuses something that is not an object', () => {
    const p = parseLpaTermsResponse({ kind: null, carryRate: null }, LPA, 'assistant')
    expect(p.notFound).toContain('kind')
    expect(() => parseLpaTermsResponse([], LPA, 'assistant')).toThrow(/JSON object/)
  })

  it('warns when a straight kind comes with a hurdle', () => {
    const p = parseLpaTermsResponse({ ...good, kind: { value: 'straight', quote: 'Distributable proceeds shall be distributed as follows:' } }, LPA, 'assistant')
    expect(p.warnings.join(' ')).toMatch(/straight carry ignores the hurdle/)
  })

  it('the prompt carries the passages, the shape and the rules', () => {
    const prompt = buildLpaTermsPrompt(relevantPassages(LPA))
    expect(prompt).toMatch(/Return ONLY valid JSON/)
    expect(prompt).toMatch(/Rates are FRACTIONS/)
    expect(prompt).toMatch(/\[Page 22\] \(Section 6\.2 Distributions\)/)
  })
})

describe('proposalToTermsInput', () => {
  const current: VehicleCarryTerms = { kind: 'european', carryRate: 0.15, prefRate: 0.06, catchupRate: 0.5, prefCompounds: false, gpEntityId: 'gp-1', recipients: [{ lpEntityId: 'gp-1', pct: 100 }] }

  it('uses the proposal, keeps current recipients, and fills gaps from the current terms', () => {
    const p = parseLpaTermsResponse({
      carryRate: { value: 0.2, quote: 'thereafter, 80% to the Limited Partners and 20% to the General Partner' },
    }, LPA, 'assistant')
    const { input, filledFrom } = proposalToTermsInput(p, current)
    expect(input).toEqual({ kind: 'european', carryRate: 0.2, prefRate: 0.06, catchupRate: 0.5, catchupSize: 1, prefCompounds: false, prefBase: 'contributed', carryRecipients: [{ lpEntityId: 'gp-1', pct: 100 }] })
    expect(filledFrom).toEqual({ kind: 'current', prefRate: 'current', catchupRate: 'current', catchupSize: 'current', prefCompounds: 'current', prefBase: 'current', carryRecipients: 'current' })
    expect(parseWaterfallTermsInput(input)).toMatchObject({ ok: true })
  })

  it('fills from engine defaults when the vehicle has no terms, and a straight kind zeroes the hurdle', () => {
    const straight = heuristicLpaTerms(`Section 5 Carried Interest\nAfter the return of all Capital Contributions, the remainder shall be distributed 80% to the Members and 20% to the Manager as carried interest.`)
    const { input, filledFrom } = proposalToTermsInput(straight, NO_CARRY)
    expect(input).toMatchObject({ kind: 'straight', carryRate: 0.2, prefRate: 0, catchupRate: 1, carryRecipients: [] })
    expect(filledFrom).toEqual({ prefCompounds: 'default' })
    // No recipient yet: the write path would refuse it until one is named.
    expect(parseWaterfallTermsInput(input)).toEqual({ error: 'Choose who receives the carry.' })
  })

  it('sourcesOf carries each term\'s clause to the staged action', () => {
    const s = sourcesOf(heuristicLpaTerms(LPA))
    expect(s.map(x => x.field)).toEqual(['kind', 'carryRate', 'prefRate', 'prefCompounds', 'catchupRate'])
    expect(s.every(x => x.quote && x.quoteVerified)).toBe(true)
  })
})

describe('parseWaterfallTermsInput (the shared write path)', () => {
  it('accepts valid terms and defaults catch-up to full and the hurdle to compounding', () => {
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, prefRate: 0.08, carryRecipients: [{ lpEntityId: 'gp', pct: 100 }] })).toEqual({
      ok: true,
      value: { kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, catchupSize: 1, prefCompounds: true, prefBase: 'contributed', prefMultiple: null, prefDayCount: 'act/365', catchupMeasure: 'preferred', carrySteps: [], capitalIncludes: ['investments', 'fees', 'expenses', 'other'], gpCommitBearsCarry: false, gpEntityId: null, recipients: [{ lpEntityId: 'gp', pct: 100 }] },
    })
  })

  it('takes a multiple hurdle, a 30/360 day count and a catch-up measured on profit', () => {
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, prefMultiple: 1.08, prefDayCount: '30/360', catchupRate: 0.5, catchupMeasure: 'profit', gpEntityId: 'gp' }))
      .toMatchObject({ ok: true, value: { prefMultiple: 1.08, prefDayCount: '30/360', catchupMeasure: 'profit' } })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, prefMultiple: 0.9, gpEntityId: 'gp' })).toEqual({ error: 'A hurdle multiple must be between 1 and 10 (1.08 = 8%).' })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, prefDayCount: 'act/360', gpEntityId: 'gp' })).toEqual({ error: 'The day count must be act/365 or 30/360.' })
    // Measured on profit, a catch-up at or below the GP's target share never catches up.
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, catchupRate: 0.1, catchupMeasure: 'profit', gpEntityId: 'gp' }))
      .toEqual({ error: 'Measured on profit, the catch-up rate must be above the share of profit the GP catches up to.' })
  })

  it('takes carry that steps up and capital that leaves fees out', () => {
    expect(parseWaterfallTermsInput({
      kind: 'european', carryRate: 0.2, gpEntityId: 'gp', capitalIncludes: ['investments'],
      carrySteps: [{ lpMultiple: 2.5, carryRate: 0.25, catchUpRate: 1 }, { lpMultiple: '', lpIrr: 0.3, carryRate: 0.3 }],
    })).toMatchObject({ ok: true, value: {
      capitalIncludes: ['investments'],
      carrySteps: [{ lpMultiple: 2.5, carryRate: 0.25, catchUpRate: 1 }, { lpIrr: 0.3, carryRate: 0.3 }],
    } })
    const step = (s: Record<string, unknown>) => parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, gpEntityId: 'gp', carrySteps: [s] })
    expect(step({ lpMultiple: 2, carryRate: 0.15 })).toEqual({ error: 'Each carry step must raise the carry rate.' })
    expect(step({ carryRate: 0.25 })).toEqual({ error: 'Each carry step starts at an LP multiple or an LP IRR, not both.' })
    expect(step({ lpMultiple: 0.9, carryRate: 0.25 })).toEqual({ error: 'Carry step multiples must rise, from above 1 up to 20.' })
    expect(step({ lpIrr: 0.2, carryRate: 0.25, catchUpRate: 0.2 })).toEqual({ error: 'A catch-up at a carry step must give the GP more of each dollar than the new rate, up to 1.' })
    expect(step({ lpMultiple: 2.5, carryRate: 0.3, catchUpRate: 1, catchUpMeasure: 'pref' })).toEqual({ error: 'A carry step\'s catch-up is measured on profit or on the split.' })
    expect(step({ lpMultiple: 2.5, carryRate: 0.3, catchUpMeasure: 'split' })).toEqual({ error: 'A carry step measured on the split needs a catch-up rate.' })
    const split = parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, gpEntityId: 'gp', carrySteps: [{ lpMultiple: 2.5, carryRate: 0.3, catchUpRate: 1, catchUpMeasure: 'split' }] })
    expect('value' in split && split.value.carrySteps).toEqual([{ lpMultiple: 2.5, carryRate: 0.3, catchUpRate: 1, catchUpMeasure: 'split' }])
    // 'profit' is the default and isn't stored.
    const profit = parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, gpEntityId: 'gp', carrySteps: [{ lpMultiple: 2.5, carryRate: 0.3, catchUpRate: 1, catchUpMeasure: 'profit' }] })
    expect('value' in profit && profit.value.carrySteps).toEqual([{ lpMultiple: 2.5, carryRate: 0.3, catchUpRate: 1 }])
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, gpEntityId: 'gp', capitalIncludes: ['fees'] })).toEqual({ error: 'Capital returned must include invested capital.' })
    expect(describeTerms({ kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, prefCompounds: true, carrySteps: [{ lpMultiple: 2.5, carryRate: 0.25 }], capitalIncludes: ['investments'] }))
      .toBe('European (whole-fund) 20% carry, 8% compounding preferred return, 100% GP catch-up, 25% once the LPs reach 2.5×, returning only investments as capital')
  })

  it('refuses what the settings page refuses, in its words', () => {
    expect(parseWaterfallTermsInput({ kind: 'tiered' })).toEqual({ error: 'kind must be none, straight, american, or european.' })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 20, gpEntityId: 'gp' })).toEqual({ error: 'Carry rate must be a fraction between 0 and 1 (0.2 = 20%).' })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, prefRate: 8, gpEntityId: 'gp' })).toEqual({ error: 'Preferred return must be a fraction between 0 and 1 (0.08 = 8%).' })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, catchupRate: 1.5, gpEntityId: 'gp' })).toEqual({ error: 'Catch-up rate must be between 0 and 1.' })
    // Any catch-up rate works, at or below the carry rate included (10% on 20% carry).
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, catchupRate: 0.1, gpEntityId: 'gp' })).toMatchObject({ ok: true, value: { catchupRate: 0.1, catchupSize: 1 } })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, catchupSize: 0.5, gpEntityId: 'gp' })).toMatchObject({ ok: true, value: { catchupSize: 0.5 } })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, catchupSize: 1.5, gpEntityId: 'gp' })).toEqual({ error: 'Catch-up size must be between 0 and 1 (1 = a full catch-up).' })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, catchupRate: 0, gpEntityId: 'gp' })).toMatchObject({ ok: true })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, prefBase: 'net', gpEntityId: 'gp' })).toEqual({ error: 'The preferred return must accrue on contributed or unreturned capital.' })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, prefBase: 'unreturned', gpEntityId: 'gp' })).toMatchObject({ ok: true, value: { prefBase: 'unreturned' } })
    expect(parseWaterfallTermsInput({ kind: 'european', carryRate: 0.2, carryRecipients: [{ lpEntityId: 'a', pct: 60 }, { lpEntityId: 'b', pct: 30 }] }))
      .toEqual({ error: 'Carry recipient percentages must total 100 (they total 90).' })
  })

  it('needs no recipient when carry is off', () => {
    expect(parseWaterfallTermsInput({ kind: 'none' })).toMatchObject({ ok: true })
  })

  it('describes terms for the approver', () => {
    expect(describeTerms({ kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, prefCompounds: true }))
      .toBe('European (whole-fund) 20% carry, 8% compounding preferred return, 100% GP catch-up')
    expect(describeTerms({ kind: 'straight', carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true })).toBe('straight 20% carry, no hurdle')
    expect(describeTerms({ kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, prefCompounds: true, prefBase: 'unreturned' })).toMatch(/preferred return on unreturned capital/)
    expect(describeTerms({ kind: 'none', carryRate: 0, prefRate: 0, catchupRate: 1, prefCompounds: true })).toBe('no carry')
    expect(describeTerms({ kind: 'straight', carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true, gpCommitBearsCarry: true })).toBe('straight 20% carry, no hurdle, the GP commit bearing carry')
  })

  it('reads whether the GP commit bears carry, false unless it says true', () => {
    const base = { kind: 'european', carryRate: 0.2, carryRecipients: [{ lpEntityId: 'gp', pct: 100 }] }
    expect(parseWaterfallTermsInput({ ...base, gpCommitBearsCarry: true })).toMatchObject({ ok: true, value: { gpCommitBearsCarry: true } })
    expect(parseWaterfallTermsInput(base)).toMatchObject({ ok: true, value: { gpCommitBearsCarry: false } })
    expect(parseWaterfallTermsInput({ ...base, gpCommitBearsCarry: 'yes' })).toMatchObject({ ok: true, value: { gpCommitBearsCarry: false } })
  })
})
