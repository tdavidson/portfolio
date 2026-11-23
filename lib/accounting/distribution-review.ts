// Reviewing a distribution before and after it is declared: the split with its checks, and the
// calculation as a workbook. Shared by the Capital accounts page's routes and the assistant's tools,
// so a person and an AI audit the same figures.

import type { SupabaseClient } from '@supabase/supabase-js'
import { previewDistribution, type DistributionPreview } from './distributions'
import { checkDistribution, loadDistributionFacts } from './distribution-check'
import {
  buildDistributionWorkbook, calcFromPreview, loadDeclaredCalc, distributionWorkbookFileName, DISTRIBUTION_XLSX_TYPE,
} from './distribution-workbook'
import { loadCarryTerms } from './carry'
import { loadEntityNames } from './load'
import { documentLetterhead } from '@/lib/vehicle-letterhead'
import { COMBINED_RECIPIENTS_NAME } from '@/lib/access/carry-visibility'
import type { DraftChecks } from '@/lib/drafting/checks'
import { foldDeclaredCarry, foldPreviewCarry } from './distribution-carry-fold'

export interface CheckedPreview extends DistributionPreview {
  checks: DraftChecks
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The split a distribution of `total` on `asOf` would get, writing nothing, with the checks. */
export async function previewWithChecks(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  total: number,
  asOf: string,
  method: 'waterfall' | 'pro_rata' = 'waterfall',
): Promise<CheckedPreview> {
  const [preview, facts, terms] = await Promise.all([
    previewDistribution(admin, fundId, group, total, asOf, method),
    loadDistributionFacts(admin, fundId, group, asOf),
    loadCarryTerms(admin, fundId, group),
  ])
  const checks = checkDistribution({
    total,
    date: asOf,
    method: preview.method,
    lines: preview.lines,
    carryLines: preview.carryLines,
    lineBreakdown: preview.lineBreakdown,
    termsKind: terms.kind,
    carryRecipients: terms.recipients.map(r => r.lpEntityId),
    warnings: preview.warnings,
    names: preview.names,
  }, facts)
  return { ...preview, checks }
}

async function fundNameFor(admin: SupabaseClient, fundId: string, group: string): Promise<string> {
  const { data: fund } = await (admin as any).from('funds').select('name, logo_url, address').eq('id', fundId).maybeSingle()
  return (await documentLetterhead(admin, fundId, fund, [group])).name || (fund as any)?.name || 'Fund'
}

async function termsFor(admin: SupabaseClient, fundId: string, group: string, hide: boolean) {
  const [terms, names] = await Promise.all([loadCarryTerms(admin, fundId, group), loadEntityNames(admin, fundId, group)])
  return {
    kind: terms.kind,
    carryRate: terms.carryRate,
    prefRate: terms.prefRate,
    prefBase: terms.prefBase ?? 'contributed',
    recipients: hide && terms.recipients.length ? [COMBINED_RECIPIENTS_NAME] : terms.recipients.map(r => names.get(r.lpEntityId) ?? r.lpEntityId),
  }
}

export type DistributionWorkbookArgs =
  | { distributionId: string }
  | { total: number; asOf: string; method?: 'waterfall' | 'pro_rata'; description?: string | null }

/**
 * The workbook for a declared distribution, or for a preview. Null when the distribution is not on
 * this vehicle. `hideRecipients` (a member without gp_economics: carryRecipientIds) folds every
 * carry recipient into one combined row (lib/accounting/distribution-carry-fold.ts).
 */
export async function distributionWorkbookDocument(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  args: DistributionWorkbookArgs,
  now: Date = new Date(),
  opts: { hideRecipients?: Set<string> | null } = {},
): Promise<{ body: Buffer; fileName: string; contentType: string } | null> {
  const fundName = await fundNameFor(admin, fundId, group)
  const generatedAt = now.toISOString()
  const hide = opts.hideRecipients && opts.hideRecipients.size ? opts.hideRecipients : null
  if ('distributionId' in args) {
    const calc = await loadDeclaredCalc(admin, fundId, group, args.distributionId, {
      fundName, generatedAt, terms: await termsFor(admin, fundId, group, !!hide),
      fold: hide ? d => foldDeclaredCarry(d, hide) : undefined,
    })
    if (!calc) return null
    return { body: buildDistributionWorkbook(calc), fileName: distributionWorkbookFileName(fundName, group, calc.date, 'declared'), contentType: DISTRIBUTION_XLSX_TYPE }
  }
  const raw = await previewWithChecks(admin, fundId, group, args.total, args.asOf, args.method ?? 'waterfall')
  const preview = hide ? foldPreviewCarry(raw, hide) : raw
  const calc = calcFromPreview(preview, { fundName, vehicle: group, date: args.asOf, description: args.description ?? null, total: args.total, checks: preview.checks, generatedAt })
  return { body: buildDistributionWorkbook(calc), fileName: distributionWorkbookFileName(fundName, group, args.asOf, 'preview'), contentType: DISTRIBUTION_XLSX_TYPE }
}
