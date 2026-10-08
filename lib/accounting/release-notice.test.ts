import { describe, it, expect } from 'vitest'
import { bankActionMessages, releaseNotice } from './release-notice'

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

describe('bankActionMessages', () => {
  it('a note or a release on success is a notice, not an error', () => {
    expect(bankActionMessages(true, { note: 'The bank row was set aside.' })).toEqual({ error: null, notice: 'The bank row was set aside.' })
    expect(bankActionMessages(true, { removedTransactions: [{ company: 'Acme' }] }))
      .toEqual({ error: null, notice: 'Deleted 1 investment transaction (Acme) recorded by the reversed entry.' })
    expect(bankActionMessages(true, {})).toEqual({ error: null, notice: null })
  })
  it('something left to do is shown as a warning', () => {
    expect(bankActionMessages(true, { warnings: ['w1'] })).toEqual({ error: 'w1', notice: null })
  })
  it('a refusal is an error; a bulk post that stopped part-way also says what it already released', () => {
    expect(bankActionMessages(false, { error: 'Closed period.' })).toEqual({ error: 'Closed period.', notice: null })
    expect(bankActionMessages(false, { error: 'Closed period.', removedTransactions: [{ company: 'Acme' }] })).toEqual({
      error: 'Closed period.',
      notice: 'The entries posted before it stopped: Deleted 1 investment transaction (Acme) recorded by the reversed entry.',
    })
    expect(bankActionMessages(false, null)).toEqual({ error: 'That could not be done.', notice: null })
  })
})
