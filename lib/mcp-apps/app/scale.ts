// Axis maths for the dashboard charts. Pure and unit-tested (scale.test.ts).

/**
 * Round tick values covering [min, max], about `count` of them, on a 1 / 2 / 5 step.
 *
 * The domain is widened to the ticks, so the top gridline always sits at or above the largest
 * value and a line never runs off the plot. A flat series (min === max) gets a band around its
 * value rather than a zero-height domain, which would put every point on the axis.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min > max) [min, max] = [max, min]
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
    min -= pad
    max += pad
  }
  const rough = (max - min) / Math.max(1, count)
  const power = Math.pow(10, Math.floor(Math.log10(rough)))
  const fraction = rough / power
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power

  const first = Math.floor(min / step) * step
  const last = Math.ceil(max / step) * step
  const ticks: number[] = []
  // Index-driven rather than accumulating `+= step`, so 0.1 steps do not drift to 0.30000000000000004.
  const n = Math.round((last - first) / step)
  for (let i = 0; i <= n; i++) ticks.push(Number((first + i * step).toPrecision(12)))
  return ticks
}

/** Map a value in [d0, d1] to [r0, r1]. A zero-width domain maps to the middle of the range. */
export function linear(d0: number, d1: number, r0: number, r1: number): (value: number) => number {
  const span = d1 - d0
  if (span === 0) return () => (r0 + r1) / 2
  return value => r0 + ((value - d0) / span) * (r1 - r0)
}

/**
 * The y-domain for a line chart of these values.
 *
 * Starts at zero when the data is all non-negative and its low point is within reach of zero:
 * a KPI that moved from 96 to 100 should not look like it quadrupled, and one that went from
 * 2M to 9M reads best from the floor. Otherwise it frames the data, on round ticks either way.
 */
export function lineDomain(values: number[], tickCount = 4): { ticks: number[]; min: number; max: number } {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return { ticks: [0, 1], min: 0, max: 1 }
  const lo = Math.min(...finite)
  const hi = Math.max(...finite)
  const fromZero = lo >= 0 && lo <= hi * 0.6
  const ticks = niceTicks(fromZero ? 0 : lo, hi, tickCount)
  return { ticks, min: ticks[0], max: ticks[ticks.length - 1] }
}

/**
 * Which x labels to draw so they do not collide: always the first and last, and as many evenly
 * spaced between as fit `maxLabels`.
 */
export function labelIndexes(length: number, maxLabels: number): number[] {
  if (length <= 0) return []
  if (length === 1) return [0]
  const want = Math.max(2, Math.min(length, Math.floor(maxLabels)))
  const out = new Set<number>()
  for (let i = 0; i < want; i++) out.add(Math.round((i * (length - 1)) / (want - 1)))
  return Array.from(out).sort((a, b) => a - b)
}
