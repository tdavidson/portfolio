// The "As of" line on an LP report card.
//
// The date is the card's own: the latest date the investor's figures are reported through. A
// fund's custom footer replaces the standard definitions text, never the date, so a custom
// footer that was saved with a date in it (copied from an earlier card) has that date dropped
// rather than printed as if it were current. No server imports: the in-app card uses this too.

/** A saved footer without a leading "As of <date>." sentence. */
export function footerWithoutDate(note: string | null | undefined): string | null {
  if (!note) return null
  const rest = note.replace(/^\s*as of\b[^.]*\d[^.]*\.\s*/i, '').trim()
  return rest || null
}

/** "2026-03-31" → "March 31, 2026". Anything that is not an ISO date passes through unchanged. */
export function formatAsOf(date: string | null | undefined): string | null {
  if (!date) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  return new Date(date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

/** The latest date any of these rows' figures are reported through, or null. */
export function reportedThrough(rows: { evidence?: { asOf: string | null } | null }[]): string | null {
  return rows.map(r => r.evidence?.asOf).filter((d): d is string => !!d).sort().at(-1) ?? null
}
