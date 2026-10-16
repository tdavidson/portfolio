/** Only the selected vehicle's LPs belong here. No nickname or amount-based guessing. */
export interface QbLpTarget {
  entityId: string
  name: string
  accountId: string
  aliases?: string[]
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Exact named counterparties first; otherwise an unambiguous full name in the memo. */
export function matchQbLp(names: string[], memos: string[], targets: QbLpTarget[]): QbLpTarget | null {
  const named = names.map(normalize).filter(Boolean)
  const labels = (t: QbLpTarget) => [t.name, ...(t.aliases ?? [])].map(normalize)
  const exact = targets.filter(t => labels(t).some(name => named.includes(name)))
  if (exact.length) return exact.length === 1 ? exact[0] : null
  // An explicit, unrecognized counterparty must not be overridden by a memo mentioning an LP.
  if (named.length) return null
  const texts = memos.filter(Boolean).map(s => ` ${normalize(s)} `)
  const hits = targets.filter(t => {
    return labels(t).some(name => name.split(' ').length >= 2 && texts.some(text => text.includes(` ${name} `)))
  })
  // Do not assign Alex Rivera when a longer joint registration also matches.
  const specific = hits.filter(t => !hits.some(other => other.entityId !== t.entityId &&
    ` ${normalize(other.name)} `.includes(` ${normalize(t.name)} `)))
  return specific.length === 1 ? specific[0] : null
}
