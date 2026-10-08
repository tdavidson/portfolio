// lib/portfolio/latest-only.ts
/**
 * Guards async loads against out-of-order responses: `begin()` starts a request and returns a
 * check that is true only while no later request has begun. A slower, older response sees false
 * and must not touch state.
 */
export function latestOnly(): { begin: () => () => boolean } {
  let seq = 0
  return { begin: () => { const mine = ++seq; return () => mine === seq } }
}
