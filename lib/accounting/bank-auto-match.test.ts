import { describe, it, expect } from 'vitest'
import { matchTransaction, descriptionNamesPartner, descriptionCarriesReference, type OpenBalance } from './bank-auto-match'

const bal = (lpEntityId: string, name: string, amount: number): OpenBalance => ({ lpEntityId, name, amount })

describe('descriptionNamesPartner', () => {
  it('finds a partner named in a wire description', () => {
    expect(descriptionNamesPartner('WIRED FUNDS SENT BENE: Dana Whitfield ACCT: XXXXXX1111', 'Dana Whitfield')).toBe(true)
  })

  it('survives the bank truncating the last token', () => {
    // Real shape: the bank cuts "GmbH" to "Gmb".
    expect(descriptionNamesPartner('WIRED FUNDS SENT BENE: Klaus Beispiel Holding Gmb ACCT: X', 'Klaus Beispiel Holding GmbH')).toBe(true)
  })

  it('ignores case and punctuation', () => {
    expect(descriptionNamesPartner('wired funds sent bene: hollis family limited partnership', 'Hollis Family Limited Partnership')).toBe(true)
    expect(descriptionNamesPartner('SENT TO: M ASHBY CARROW', 'M. Ashby Carrow')).toBe(true)
  })

  it('does NOT match on a shared first name alone', () => {
    // The failure that would move one partner's money into another's account.
    expect(descriptionNamesPartner('WIRED FUNDS SENT BENE: Michael J. Corwin', 'Michael Brandt')).toBe(false)
  })

  it('does not match an unrelated description', () => {
    expect(descriptionNamesPartner('ACME TREASURY GOVT OBL PRM', 'Dana Whitfield')).toBe(false)
  })
})

describe('matchTransaction', () => {
  it('matches on amount when only one partner fits', () => {
    const r = matchTransaction(-8_400, 'ANY DESCRIPTION', [bal('a', 'Peter G. Halloway', 8_400), bal('b', 'Dana Whitfield', 12_600)])
    expect(r).toEqual({ kind: 'matched', lpEntityId: 'a', name: 'Peter G. Halloway', by: 'amount' })
  })

  it('uses the description to break a tie between identical amounts', () => {
    // Four partners at the same figure is the real case, not a contrived one.
    const open = [
      bal('a', 'Gina Marlowe', 4_200), bal('b', 'Michael Brandt', 4_200),
      bal('c', 'Kat Moreno', 4_200), bal('d', 'M. Ashby Carrow', 4_200),
    ]
    const r = matchTransaction(-4_200, 'WIRED FUNDS SENT BENE: Michael Brandt ACCT: XXXXXXX2222', open)
    expect(r).toEqual({ kind: 'matched', lpEntityId: 'b', name: 'Michael Brandt', by: 'amount+name' })
  })

  it('REFUSES to guess when the amount ties and no name appears', () => {
    const open = [bal('a', 'Gina Marlowe', 4_200), bal('b', 'Michael Brandt', 4_200)]
    const r = matchTransaction(-4_200, 'OUTGOING WIRE 5550100', open)
    expect(r.kind).toBe('ambiguous')
    expect(r.kind === 'ambiguous' && r.candidates).toHaveLength(2)
  })

  it('refuses when the description names two of the tied partners', () => {
    const open = [bal('a', 'Dana Whitfield', 4_200), bal('b', 'Michael Brandt', 4_200)]
    const r = matchTransaction(-4_200, 'WIRE TO Dana Whitfield AND Michael Brandt', open)
    expect(r.kind).toBe('ambiguous')
  })

  it('returns none when nothing is owed at that amount', () => {
    expect(matchTransaction(-999, 'WIRED FUNDS SENT BENE: Dana Whitfield', [bal('a', 'Dana Whitfield', 4_200)]).kind).toBe('none')
  })

  it('works off the absolute amount, so direction is the caller’s concern', () => {
    const open = [bal('a', 'Dana Whitfield', 12_600)]
    expect(matchTransaction(12_600, null, open).kind).toBe('matched')
    expect(matchTransaction(-12_600, null, open).kind).toBe('matched')
  })

  it('ignores a zero-value transaction', () => {
    expect(matchTransaction(0, 'ANYTHING', [bal('a', 'Dana Whitfield', 0)]).kind).toBe('none')
  })

  it('tolerates sub-cent drift but not a real difference', () => {
    const open = [bal('a', 'Dana Whitfield', 12_600)]
    expect(matchTransaction(-12_600.004, null, open).kind).toBe('matched')
    expect(matchTransaction(-12_601, null, open).kind).toBe('none')
  })
})

describe('the acknowledged wire reference as a tiebreak', () => {
  it('resolves an amount tie when the description quotes a reference one partner gave', () => {
    const open: OpenBalance[] = [
      { ...bal('a', 'Alpha Holdings', 100_000), references: ['ALPHA-CALL4'] },
      { ...bal('b', 'Beta Trust', 100_000), references: [] },
    ]
    const m = matchTransaction(100_000, 'INCOMING WIRE REF ALPHA-CALL4 FROM ACCT 1234', open)
    expect(m).toMatchObject({ kind: 'matched', lpEntityId: 'a', by: 'amount+reference' })
  })

  it('stays ambiguous when no reference is quoted', () => {
    const open: OpenBalance[] = [
      { ...bal('a', 'Alpha Holdings', 100_000), references: ['ALPHA-CALL4'] },
      { ...bal('b', 'Beta Trust', 100_000), references: ['BETA-4'] },
    ]
    expect(matchTransaction(100_000, 'INCOMING WIRE', open).kind).toBe('ambiguous')
  })

  it('ignores references too short to be distinctive', () => {
    expect(descriptionCarriesReference('INCOMING WIRE 4', ['4'])).toBe(false)
    expect(descriptionCarriesReference('INCOMING WIRE CALL4', ['call4'])).toBe(true)
  })
})
