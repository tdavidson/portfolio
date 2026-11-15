import { describe, it, expect } from 'vitest'
import { tokenAllowedAt } from './audience'

describe('tokenAllowedAt — a token is used only at the boundary it names', () => {
  it('accepts a token at its own boundary only', () => {
    expect(tokenAllowedAt('https://app.example/api/mcp', 'mcp')).toBe(true)
    expect(tokenAllowedAt('https://app.example/api/mcp', 'v1')).toBe(false)
    expect(tokenAllowedAt('https://app.example/api/v1', 'v1')).toBe(true)
    expect(tokenAllowedAt('https://app.example/api/portal/mcp', 'mcp')).toBe(false)
  })

  it('refuses a token that names no resource, or one we do not serve, everywhere', () => {
    for (const boundary of ['mcp', 'v1', 'portal'] as const) {
      expect(tokenAllowedAt(null, boundary)).toBe(false)
      expect(tokenAllowedAt(undefined, boundary)).toBe(false)
      expect(tokenAllowedAt('https://elsewhere.example/other', boundary)).toBe(false)
      expect(tokenAllowedAt('not a url', boundary)).toBe(false)
    }
  })
})
