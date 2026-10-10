import { describe, expect, it } from 'vitest'
import { callActivityRows } from './call-activity'

describe('callActivityRows', () => {
  it('lays a call out the way Carta does: prepaid, received, earlier balances, total due, post-call', () => {
    const first = { id: 'c1', callDate: '2026-03-01', dueDate: null, lines: [
      { lpEntityId: 'b', name: 'Birch LP', amount: 12000, settled: 0, outstanding: 12000 },
    ] }
    const call = { id: 'c2', callDate: '2026-09-15', dueDate: '2026-09-30', lines: [
      { lpEntityId: 'a', name: 'Alder LP', amount: 7500, settled: 7500, outstanding: 0 },
      { lpEntityId: 'p', name: 'Pine LP', amount: 750, settled: 750, outstanding: 0, advanceApplied: 750 },
      { lpEntityId: 'b', name: 'Birch LP', amount: 37500, settled: 0, outstanding: 37500, charges: [{ amount: 250 }] },
    ] }
    const partners = [
      { lpEntityId: 'a', name: 'Alder LP', commitment: 50000, called: 7500 },
      { lpEntityId: 'p', name: 'Pine LP', commitment: 5000, called: 750 },
      { lpEntityId: 'b', name: 'Birch LP', commitment: 250000, called: 49500 },
      { lpEntityId: 'z', name: 'Zelkova LP', commitment: 100000, called: 0 },
    ]
    const r = callActivityRows(call, [first, call], partners)
    expect(r.participating.map(x => [x.name, x.prepaid, x.received, x.earlierOutstanding, x.charges, x.totalDue, x.postCall])).toEqual([
      ['Alder LP', 0, 7500, 0, 0, 7500, 42500],
      ['Birch LP', 0, 0, 12000, 250, 49750, 200500],
      ['Pine LP', 750, 0, 0, 0, 0, 4250],
    ])
    expect(r.notCalled).toEqual(['Zelkova LP'])
  })
})
