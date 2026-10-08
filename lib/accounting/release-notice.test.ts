import { describe, it, expect } from 'vitest'
import { releaseNotice } from './release-notice'

describe('releaseNotice', () => {
  it('says nothing when nothing was released', () => {
    expect(releaseNotice({ removedTransactions: [], unlinkedRegisterRows: [] })).toBeNull()
    expect(releaseNotice(null)).toBeNull()
  })
  it('names what a posted reversal deleted and unlinked', () => {
    expect(releaseNotice({ removedTransactions: [{ company: 'Acme' }, { company: 'Acme' }], unlinkedRegisterRows: ['the call of 2026-03-01'] }))
      .toBe('Deleted 2 investment transactions (Acme) recorded by the reversed entries. No longer linked to a transaction: the call of 2026-03-01.')
  })
  it('carries the warning when the release failed part-way', () => {
    expect(releaseNotice({ warnings: [{ warning: 'The reversal was posted, but its transactions could not be deleted.' }] }))
      .toBe('The reversal was posted, but its transactions could not be deleted.')
    expect(releaseNotice({ warning: 'w1', warnings: ['w2'] })).toBe('w1 w2')
  })
})
