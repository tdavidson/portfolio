import type { DimensionScore } from '@/lib/memo-agent/stages/score'

// The scoring table as both memo exports (Word/PDF and Markdown) print it. Readers see a plain
// dimension name, the score and the confidence; the scoring mode is the app's own bookkeeping and
// stays out, except that a partner-only score still waiting for the partner says so.

export const SCORE_TABLE_HEADERS = ['Dimension', 'Score', 'Confidence', 'Rationale'] as const

/** `team_founder_market_fit` → `Team founder market fit`. */
export function dimensionLabel(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id
}

export function scoreLabel(s: Pick<DimensionScore, 'score' | 'mode'>): string {
  if (s.score !== null && s.score !== undefined) return String(s.score)
  return s.mode === 'partner_only' ? 'Partner' : '—'
}

export function confidenceLabel(c: DimensionScore['confidence'] | undefined): string {
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : '—'
}
