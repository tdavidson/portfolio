import { describe, expect, it } from 'vitest'
import { defaultCutoff } from './service'

describe('defaultCutoff', () => {
  it('reads posted months past the last close as actuals', () => {
    expect(defaultCutoff('2025-12', '2026-09', '2026-11')).toBe('2026-09')
  })
  it('keeps the close when nothing is posted after it', () => {
    expect(defaultCutoff('2026-06', '2026-03', '2026-11')).toBe('2026-06')
  })
  it('needs no close at all', () => {
    expect(defaultCutoff(null, '2026-08', '2026-11')).toBe('2026-08')
  })
  it('falls back to last month with no books', () => {
    expect(defaultCutoff(null, null, '2026-11')).toBe('2026-10')
  })
})
