// The fund's memo design template: one of its sample memos (style anchors), picked in Settings, whose
// Word file the export writes each memo into (render/design-template.ts). Stored on fund_settings as
// memo_design_anchor_id. The file stays in the fund's own storage; nothing about it is in the repo.

import type { SupabaseClient } from '@supabase/supabase-js'
import { analyzeMemoDesign, type MemoDesign } from './render/design-template'

export const STYLE_ANCHOR_BUCKET = 'style-anchor-memos'

export interface DesignAnchor {
  id: string
  file_name: string
  file_format: string
  storage_path: string
  title: string | null
}

export type DesignTemplate =
  | { status: 'none' }
  | { status: 'unusable'; anchor: DesignAnchor; reason: string }
  | { status: 'ready'; anchor: DesignAnchor; bytes: Buffer }

export async function designAnchorId(admin: SupabaseClient, fundId: string): Promise<string | null> {
  const { data } = await (admin as any)
    .from('fund_settings').select('memo_design_anchor_id').eq('fund_id', fundId).maybeSingle()
  return (data as { memo_design_anchor_id: string | null } | null)?.memo_design_anchor_id ?? null
}

/** The fund's design template file, when it has picked one and it is a Word file. */
export async function loadDesignTemplate(admin: SupabaseClient, fundId: string, anchorId?: string | null): Promise<DesignTemplate> {
  const id = anchorId === undefined ? await designAnchorId(admin, fundId) : anchorId
  if (!id) return { status: 'none' }
  const { data: anchor } = await (admin as any)
    .from('style_anchor_memos')
    .select('id, file_name, file_format, storage_path, title')
    .eq('fund_id', fundId).eq('id', id).maybeSingle()
  if (!anchor) return { status: 'none' }
  const a = anchor as DesignAnchor
  if (String(a.file_format).toLowerCase() !== 'docx' && !/\.docx$/i.test(a.file_name)) {
    return {
      status: 'unusable', anchor: a,
      reason: `${a.file_name} is a ${String(a.file_format).toUpperCase()}, and only a Word (.docx) file carries its design. ` +
        'Upload the Word version of this memo as a sample and pick that one.',
    }
  }
  const { data: blob, error } = await admin.storage.from(STYLE_ANCHOR_BUCKET).download(a.storage_path)
  if (error || !blob) return { status: 'unusable', anchor: a, reason: `${a.file_name} could not be read from storage.` }
  return { status: 'ready', anchor: a, bytes: Buffer.from(await blob.arrayBuffer()) }
}

/** What the export takes from the template: its section headings and first-page fields. */
export async function describeDesignTemplate(admin: SupabaseClient, fundId: string, anchorId?: string | null): Promise<
  { status: 'none' } | { status: 'unusable'; anchor: DesignAnchor; reason: string } | { status: 'ready'; anchor: DesignAnchor; design: MemoDesign }
> {
  const t = await loadDesignTemplate(admin, fundId, anchorId)
  if (t.status !== 'ready') return t
  try {
    return { status: 'ready', anchor: t.anchor, design: await analyzeMemoDesign(t.bytes) }
  } catch (err) {
    return { status: 'unusable', anchor: t.anchor, reason: err instanceof Error ? err.message : String(err) }
  }
}
