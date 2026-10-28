// The dashboard's search box — the Jump to palette's matcher, over the dashboard's own companies.
//
// Same ranking as ⌘K (lib/nav/palette.ts) so a name finds the same company in the same order in
// both places: whole-name prefix beats word prefix beats substring, every token has to match, and
// the name outweighs the aliases, tags and industries it can also hit.

import { matchEntries, type PaletteEntry } from '@/lib/nav/palette'

export interface SearchableCompany {
  id: string
  name: string
  aliases?: string[] | null
  tags?: string[] | null
  industry?: string[] | null
}

/** The companies matching `query`, best match first. A blank query matches nothing. */
export function searchCompanies<T extends SearchableCompany>(query: string, companies: T[]): T[] {
  if (!query.trim()) return []
  const byId = new Map(companies.map(c => [c.id, c]))
  const entries: PaletteEntry[] = companies.map(c => ({
    id: c.id,
    label: c.name,
    href: `/companies/${c.id}`,
    group: 'companies',
    keywords: [...(c.aliases ?? []), ...(c.tags ?? []), ...(c.industry ?? [])],
  }))
  return matchEntries(query, entries, companies.length).map(e => byId.get(e.id)!)
}
