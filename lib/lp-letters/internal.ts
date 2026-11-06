// The part of a letter that is for the partners only.
//
// Every drafted letter ends with a "Missing information" section (brief.ts's rules): what the
// sources lacked, for whoever reviews the draft. It must never reach an investor. So it is kept
// apart from the letter text (lp_letters.internal_notes), and anything an investor can see (the
// portal page, the portal's tools, the PDF, the exports) shows the letter text without it, even for
// a letter saved before the two were kept apart.
//
// Pure: no server imports.

/** The heading of a letter's closing section for the partners (brief.ts asks every draft to end with it). */
export const MISSING_HEADING = 'Missing information'

// The heading on a line of its own, as the rules ask for it: "Missing information", optionally
// with a colon, in any case, with or without a markdown "#" or bold marks around it.
const HEADING = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*)?${MISSING_HEADING}(?:\\*\\*)?[ \\t]*:?[ \\t]*$`, 'im')

export interface SplitLetter {
  /** The letter as investors may see it. */
  body: string
  /** The "Missing information" section, heading included, or null when there is none. */
  internal: string | null
}

/** Split a letter's text at its "Missing information" heading: everything from there on is internal. */
export function splitInternal(text: string | null | undefined): SplitLetter {
  const t = text ?? ''
  const m = HEADING.exec(t)
  if (!m) return { body: t, internal: null }
  // The notes keep their heading, without a markdown mark in front of it.
  return { body: t.slice(0, m.index).replace(/[\s─-]+$/, '').trimEnd(), internal: t.slice(m.index).trim().replace(/^#{1,6}[ \t]*/, '') }
}

/** A letter's text as an investor may see it. */
export function investorText(text: string | null | undefined): string {
  return splitInternal(text).body
}
