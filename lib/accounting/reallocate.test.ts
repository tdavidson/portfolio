import { describe, expect, it } from 'vitest'
import { afterCursor, closedInWindow, cursorFor, orderSources, type ReallocationSource } from './reallocate'

const src = (id: string, entryDate: string, createdAt = '2026-01-01T00:00:00Z'): ReallocationSource => ({ id, entryDate, createdAt })

describe('reallocate ordering', () => {
  const sources = [
    src('c', '2021-03-31'),
    src('a', '2020-12-31', '2026-01-02T00:00:00Z'),
    src('b', '2020-12-31', '2026-01-01T00:00:00Z'),
    src('d', '2022-06-30'),
  ]

  it('re-splits in date order, then the order the entries were made', () => {
    expect(orderSources(sources).map(s => s.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('resumes after the cursor', () => {
    const ordered = orderSources(sources)
    expect(afterCursor(ordered, null).map(s => s.id)).toEqual(['b', 'a', 'c', 'd'])
    expect(afterCursor(ordered, cursorFor(ordered[1])).map(s => s.id)).toEqual(['c', 'd'])
    expect(afterCursor(ordered, cursorFor(ordered[3]))).toEqual([])
  })

  it('refuses a cursor from another run', () => {
    expect(() => afterCursor(orderSources(sources), '2019-01-01|x|nope')).toThrow(/cursor/)
  })
})

describe('closedInWindow', () => {
  const closed = [
    { period_start: '2020-11-01', period_end: '2020-11-30' },
    { period_start: '2020-12-01', period_end: '2020-12-31' },
    { period_start: '2021-01-01', period_end: '2021-01-31' },
  ]

  it('finds the closed periods the window touches', () => {
    expect(closedInWindow(closed, '2020-12-15', null).map(p => p.period_start)).toEqual(['2020-12-01', '2021-01-01'])
    expect(closedInWindow(closed, '2020-10-01', '2020-11-15').map(p => p.period_start)).toEqual(['2020-11-01'])
  })

  it('passes a window that starts after every closed period', () => {
    expect(closedInWindow(closed, '2021-02-01', null)).toEqual([])
  })
})
