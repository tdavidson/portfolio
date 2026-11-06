// Bringing a letter back from a Google Doc the partners edited.
//
// Nothing syncs on its own: a person pastes the doc's link, sees what changed against the draft, and
// only then replaces the draft's text. The app stays the record of what was sent. Pure: no server
// imports. The route is app/api/lp-letters/[id]/pull-google-doc.

/** The document id in a Google Docs link, or a bare id. Null when it isn't one. */
export function parseGoogleDocUrl(input: string): string | null {
  const s = input.trim()
  const m = s.match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/)
  if (m) return m[1]
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null
}

/** A Google Doc's plain-text export as letter text: no BOM, Unix line ends, no trailing spaces, at most one blank line in a row. */
export function normalizeDocText(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface LineChange {
  kind: 'added' | 'removed'
  line: string
}

export interface DraftDiff {
  added: number
  removed: number
  unchanged: number
  /** The changed lines in order, at most `limit`. */
  changes: LineChange[]
}

/** What replacing `before` with `after` changes, line by line (blank lines ignored). */
export function diffDraft(before: string, after: string, limit = 200): DraftDiff {
  const a = before.split('\n').map(l => l.trim()).filter(Boolean)
  const b = after.split('\n').map(l => l.trim()).filter(Boolean)
  // Longest common subsequence over lines; letters are a few hundred lines, so n*m is small.
  const n = a.length, m = b.length
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const changes: LineChange[] = []
  let added = 0, removed = 0, unchanged = 0, i = 0, j = 0
  const push = (c: LineChange) => { if (changes.length < limit) changes.push(c) }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { unchanged++; i++; j++ }
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { removed++; push({ kind: 'removed', line: a[i++] }) }
    else { added++; push({ kind: 'added', line: b[j++] }) }
  }
  return { added, removed, unchanged, changes }
}
