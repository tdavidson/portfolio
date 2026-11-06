import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveAnchors } from '@/lib/memo-agent/style-anchors'

type Admin = ReturnType<typeof createAdminClient>

const FIRST_PAGE_BUDGET = 2500  // chars of the exemplar's opening to show

/**
 * Build a "fund memo template" block for the draft prompts. Partner feedback
 * was that voice was extracted from sample memos but structure/layout — the
 * first page especially — was ignored. This block gives the draft stage:
 *
 *   - the opening of the fund's designated first-page exemplar memo, so the
 *     drafted memo's first page is modelled on the fund's own format;
 *   - a note that the fund's sample memos are the structural reference.
 *
 * Returns '' when the fund has no style anchors / no exemplar configured.
 */
export async function buildMemoTemplateBlock(admin: Admin, fundId: string): Promise<string> {
  const { data: settings } = await admin
    .from('fund_settings')
    .select('memo_first_page_anchor_id, memo_design_anchor_id')
    .eq('fund_id', fundId)
    .maybeSingle()
  // The design template is the first-page model too, unless the fund picked a separate one.
  const st = settings as { memo_first_page_anchor_id: string | null; memo_design_anchor_id?: string | null } | null
  const exemplarId = st?.memo_first_page_anchor_id ?? st?.memo_design_anchor_id ?? null

  const anchors = await getActiveAnchors(fundId, admin)
  if (anchors.length === 0) return ''

  const exemplar = exemplarId ? anchors.find(a => a.id === exemplarId) : null
  const parts: string[] = ['=== FUND MEMO TEMPLATE ===']

  if (exemplar?.extracted_text) {
    const opening = exemplar.extracted_text.slice(0, FIRST_PAGE_BUDGET).trim()
    parts.push(
      `The fund's memos open in a consistent format. Model this memo's first page —`,
      `title block, framing, and the opening section — on the example below. Match its`,
      `structure and tone; substitute this deal's specifics.`,
      '',
      `--- FIRST-PAGE EXEMPLAR (from "${exemplar.title ?? exemplar.file_name}") ---`,
      opening,
      '--- end exemplar ---',
    )
  } else {
    parts.push(
      `The fund has ${anchors.length} sample memo${anchors.length === 1 ? '' : 's'} on file.`,
      `Mirror their section structure and the way they open. (No specific first-page`,
      `exemplar is set — pick the most representative format.)`,
    )
  }

  return parts.join('\n')
}
