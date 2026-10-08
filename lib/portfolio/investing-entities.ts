// lib/portfolio/investing-entities.ts
export interface EntityChoice { id: string; name: string }

// A management company records fee receivables in 1100 and a GP entity carry in 4000; investments
// are recorded in the fund that holds them, and derivation refuses these kinds (from-portfolio.ts).
const NOT_INVESTING = new Set(['manco', 'associate'])

/**
 * The entities a fund holding can be held by, from `/api/entities` (the caller's own entities —
 * a portfolio-domain list, unlike the accounting vehicle index): active and investing.
 */
export function investingEntities(rows: unknown): EntityChoice[] {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((v: any) => v && typeof v.id === 'string' && typeof v.name === 'string' && v.active !== false && !NOT_INVESTING.has(v.kind))
    .map((v: any) => ({ id: v.id as string, name: v.name as string }))
}
