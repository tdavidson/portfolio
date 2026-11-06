// The design template's headings as the memo's section list, matched to the fund's memo_output
// schema sections (so the agent knows what each one covers) or added as custom sections.

import type { SupabaseClient } from '@supabase/supabase-js'
import yaml from 'js-yaml'
import { ensureDefaults, getActiveSchema } from './firm-schemas'
import { sectionsFromHeadings } from './render/design-template'

export function schemaSectionsOf(memoOutputYaml: string): Array<{ id: string; title: string }> {
  try {
    const parsed = yaml.load(memoOutputYaml) as any
    const list = parsed?.memo_structure?.sections
    return Array.isArray(list) ? list.filter((s: any) => s?.id && s.id !== 'header').map((s: any) => ({ id: String(s.id), title: String(s.title ?? s.id) })) : []
  } catch {
    return []
  }
}

export async function designSections(admin: SupabaseClient, fundId: string, headings: string[]) {
  if (headings.length === 0) return []
  await ensureDefaults(fundId, admin as any)
  const schema = await getActiveSchema(fundId, 'memo_output', admin as any)
  return sectionsFromHeadings(headings, schemaSectionsOf(schema?.yaml_content ?? ''))
}

/**
 * A deal's memo sections: its own section config when a partner has set one, else the fund design
 * template's headings (so a memo is written, and exported, under the fund's own section names in the
 * fund's own order), else none (the schema's list).
 */
export async function effectiveSections<T extends { id: string; title: string }>(
  admin: SupabaseClient, fundId: string, dealSections: T[] | undefined | null,
): Promise<Array<T | ReturnType<typeof sectionsFromHeadings>[number]> | undefined> {
  if (Array.isArray(dealSections) && dealSections.length > 0) return dealSections
  const { describeDesignTemplate } = await import('./design')
  const t = await describeDesignTemplate(admin, fundId)
  if (t.status !== 'ready' || t.design.headings.length === 0) return undefined
  return designSections(admin, fundId, t.design.headings)
}
