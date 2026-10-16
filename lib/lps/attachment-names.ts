// The file names of the PDFs an LP email attaches, without rendering them: lib/lp-report-pdf.ts
// names what it renders with these, and lp_send_item's preview shows them before anything is sent.
// Kept apart from the renderer, which launches headless Chromium (lib/pdf-routes.mjs).

import type { SupabaseClient } from '@supabase/supabase-js'

const safe = (s: unknown, fallback: string) => String(s || fallback).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || fallback

/** A snapshot statement: one per recipient, named for their (first) investor. */
export function snapshotPdfFileName(investorName: string, snapshotName: string | null | undefined): string {
  return `${safe(investorName, 'Report')} - ${safe(snapshotName, 'Report')}.pdf`
}

/** An LP letter: the same file for everyone. */
export function letterPdfFileName(fundName: string | null | undefined, periodLabel: string | null | undefined): string {
  return `${safe(fundName, 'Letter')} - ${safe(periodLabel, 'Letter')}.pdf`
}

/**
 * What the attachment will be called, for a preview: the exact name for a letter or an uploaded
 * document, and the pattern for a snapshot (each recipient's carries their own investor's name).
 */
export async function attachmentNameFor(admin: SupabaseClient, fundId: string, kind: unknown, id: string): Promise<string | null> {
  const a = admin as any
  if (kind === 'letter') {
    const [{ data: letter }, { data: fund }] = await Promise.all([
      a.from('lp_letters').select('period_label').eq('id', id).eq('fund_id', fundId).maybeSingle(),
      a.from('funds').select('name').eq('id', fundId).maybeSingle(),
    ])
    return letter ? letterPdfFileName(fund?.name, letter.period_label) : null
  }
  if (kind === 'snapshot') {
    const { data: snap } = await a.from('lp_snapshots').select('name').eq('id', id).eq('fund_id', fundId).maybeSingle()
    return snap ? `<investor name> - ${safe(snap.name, 'Report')}.pdf` : null
  }
  if (kind === 'document') {
    const { data: doc } = await a.from('lp_documents').select('file_name').eq('id', id).eq('fund_id', fundId).maybeSingle()
    return doc?.file_name ?? null
  }
  return null
}
