import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The fund-holding UI is portfolio-domain: a member without accounting access records notices and
 * NAVs here. It must not depend on an accounting route — the Book-mark banner did, and silently did
 * nothing for portfolio-only users — and it picks entities from /api/entities.
 */
describe('fund-holding UI sources', () => {
  for (const f of ['components/fund-holding-detail.tsx', 'components/add-fund-holding-button.tsx']) {
    it(`${f} calls no accounting route and picks entities from /api/entities`, () => {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toMatch(/\/api\/accounting\//)
      expect(src).toContain("'/api/entities'")
    })
  }
})
