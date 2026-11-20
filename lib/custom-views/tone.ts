// Conditional colour for custom views, the same in the app, in Claude's view and in the PDF. Pure:
// each renderer turns the answer into its own colour (a theme token, or a fixed colour on paper).
//
// A shade is the share of the largest magnitude in its column or grid, so the biggest figure is
// the strongest cell; its sign says which colour (gains in the series colour, losses in red).

export interface Shade { strength: number; negative: boolean }

/** The largest magnitude among the numbers, or 0. */
export function maxMagnitude(values: unknown[]): number {
  let m = 0
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) m = Math.max(m, Math.abs(v))
  return m
}

/** A cell's shade: strength 0..1 (kept light enough to read text over), or null for no number. */
export function shadeOf(v: unknown, max: number): Shade | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || max <= 0 || v === 0) return null
  return { strength: Math.round((Math.abs(v) / max) * 100) / 100, negative: v < 0 }
}

/** The background alpha for a shade: never so dark the figure on it stops reading. */
export const shadeAlpha = (s: Shade) => 0.08 + s.strength * 0.42

/** sign tone: which way a figure points. */
export function signOf(v: unknown): 'gain' | 'loss' | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return null
  return v > 0 ? 'gain' : 'loss'
}

/** A dial's fill, 0..1, and where a target sits on it. */
export function gaugeShare(value: number | null | undefined, max: number | null | undefined): number | null {
  if (value == null || max == null || !(max > 0)) return null
  return Math.max(0, Math.min(1, value / max))
}

/** Sparkline path in a w×h box (oldest first), or null with fewer than two points. */
export function sparkPath(values: number[], w: number, h: number): string | null {
  if (values.length < 2) return null
  const lo = Math.min(...values), hi = Math.max(...values)
  const span = hi - lo || 1
  return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / span) * h).toFixed(1)}`).join(' ')
}

/** The arc of a semicircular dial from 0 to `share`, centred at (cx, cy). */
export function gaugeArc(share: number, cx: number, cy: number, r: number): string {
  const a = Math.PI * (1 - Math.max(0, Math.min(1, share)))
  const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a)
  return `M${(cx - r).toFixed(1)},${cy.toFixed(1)} A${r},${r} 0 0 1 ${x.toFixed(1)},${y.toFixed(1)}`
}

/** A point on the dial at `share` (for the target tick). */
export function gaugePoint(share: number, cx: number, cy: number, r: number): { x: number; y: number } {
  const a = Math.PI * (1 - Math.max(0, Math.min(1, share)))
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) }
}
