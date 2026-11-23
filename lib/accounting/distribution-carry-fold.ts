// A distribution as a member without gp_economics may see it.
//
// The rule is lib/access/carry-visibility.ts's: what each carry RECIPIENT receives is GP economics,
// so a recipient never appears on their own. Every line of every recipient (their carry and any
// distribution on their own capital) folds into one combined row per role, so the split still adds
// up to the total and the fund's carry stays visible. LPs' lines are untouched.
//
// Used by the workbook, the assistant's distribution tools and the notice review. The folds are
// pure; `recipientsToHide` decides whether to fold at all.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { COMBINED_RECIPIENTS_ID, COMBINED_RECIPIENTS_NAME, carryRecipientIds, seesIndividualCarry } from '@/lib/access/carry-visibility'
import type { DeclaredDistribution, DeclaredDistributionLine } from './distributions'
import type { CheckedPreview } from './distribution-review'
import type { DraftFlag } from '@/lib/drafting/checks'
import { roundCents } from './ledger'

/** The carry recipients to fold for this member: null when they may see each one. */
export async function recipientsToHide(admin: SupabaseClient, fundId: string, group: string, access: AccessContext): Promise<Set<string> | null> {
  if (seesIndividualCarry(access)) return null
  const ids = await carryRecipientIds(admin, fundId, group)
  return ids.size ? ids : null
}

type Amount = { lpEntityId: string; amount: number }

function foldAmounts<T extends Amount>(rows: T[], recipients: Set<string>): T[] {
  const folded = rows.filter(r => recipients.has(r.lpEntityId))
  if (folded.length === 0) return rows
  const sum = { ...folded[0], lpEntityId: COMBINED_RECIPIENTS_ID, amount: roundCents(folded.reduce((s, r) => s + r.amount, 0)) }
  return [...rows.filter(r => !recipients.has(r.lpEntityId)), sum]
}

/** Numeric fields summed, the rest from the first row. */
function foldNumeric<T extends { lpEntityId: string }>(rows: T[], recipients: Set<string>): T[] {
  const folded = rows.filter(r => recipients.has(r.lpEntityId))
  if (folded.length === 0) return rows
  const sum = { ...folded[0], lpEntityId: COMBINED_RECIPIENTS_ID } as T
  for (const k of Object.keys(folded[0]) as (keyof T)[]) {
    if (typeof folded[0][k] === 'number') (sum as any)[k] = roundCents(folded.reduce((s, r) => s + (r[k] as unknown as number), 0))
  }
  return [...rows.filter(r => !recipients.has(r.lpEntityId)), sum]
}

/** A check about one recipient says which check it was, not their figures. */
export function foldFlags(flags: DraftFlag[], recipients: Set<string>): DraftFlag[] {
  const out: DraftFlag[] = []
  const seen = new Set<string>()
  for (const f of flags) {
    if (!f.subject || !recipients.has(f.subject)) { out.push(f); continue }
    if (seen.has(f.code)) continue
    seen.add(f.code)
    out.push({
      ...f, subject: COMBINED_RECIPIENTS_ID,
      message: f.code === 'gp_capital_and_carry'
        ? 'A carry recipient receives both a distribution on its own capital and carried interest. Its notice shows the two separately.'
        : `A check (${f.code}) concerns a carry recipient. What each recipient receives is GP economics, which your access does not include; someone with that access can see the detail.`,
    })
  }
  return out
}

export function foldPreviewCarry(p: CheckedPreview, recipients: Set<string>): CheckedPreview {
  if (recipients.size === 0) return p
  const touches = [...p.lines, ...p.carryLines].some(l => recipients.has(l.lpEntityId))
  if (!touches) return p
  const names: Record<string, string> = {}
  for (const [id, n] of Object.entries(p.names)) if (!recipients.has(id)) names[id] = n
  names[COMBINED_RECIPIENTS_ID] = COMBINED_RECIPIENTS_NAME
  return {
    ...p,
    names,
    lines: foldAmounts(p.lines, recipients),
    carryLines: foldAmounts(p.carryLines, recipients),
    carryFreeLines: p.carryFreeLines ? foldNumeric(p.carryFreeLines, recipients) : p.carryFreeLines,
    lineBreakdown: foldNumeric(p.lineBreakdown, recipients),
    groups: p.groups?.map(g => ({ ...g, lpEntityIds: Array.from(new Set(g.lpEntityIds.map(id => (recipients.has(id) ? COMBINED_RECIPIENTS_ID : id)))) })),
    terms: { ...p.terms, recipients: [COMBINED_RECIPIENTS_NAME] },
    checks: { ...p.checks, flags: foldFlags(p.checks.flags, recipients) },
  }
}

function foldDeclaredLines(lines: DeclaredDistributionLine[], recipients: Set<string>): DeclaredDistributionLine[] {
  const out = lines.filter(l => !recipients.has(l.lpEntityId))
  for (const role of ['lp', 'carry'] as const) {
    const folded = lines.filter(l => recipients.has(l.lpEntityId) && l.role === role)
    if (folded.length === 0) continue
    const sum = (f: (l: DeclaredDistributionLine) => number) => roundCents(folded.reduce((s, l) => s + f(l), 0))
    const character = { ...folded[0].character }
    for (const k of Object.keys(character) as (keyof typeof character)[]) {
      if (typeof character[k] === 'number') (character as any)[k] = sum(l => Number((l.character as any)[k] ?? 0))
    }
    const deductions = sum(l => (l.deductions ?? []).reduce((s, d) => s + d.amount, 0))
    const outstanding = sum(l => l.outstanding)
    const hasBreakdown = folded.some(l => l.breakdown)
    out.push({
      id: `${COMBINED_RECIPIENTS_ID}:${role}`,
      lpEntityId: COMBINED_RECIPIENTS_ID,
      name: COMBINED_RECIPIENTS_NAME,
      amount: sum(l => l.amount),
      role,
      character,
      settled: sum(l => l.settled),
      outstanding,
      status: outstanding <= 0.005 ? folded[0].status : (folded.find(l => l.outstanding > 0.005)?.status ?? folded[0].status),
      settledOn: null,
      noticeDocumentId: null,
      ...(deductions ? { deductions: [{ amount: deductions, description: 'Deductions (combined)' }] } : {}),
      breakdown: hasBreakdown
        ? { returnOfCapital: sum(l => l.breakdown?.returnOfCapital ?? 0), preferred: sum(l => l.breakdown?.preferred ?? 0), profit: sum(l => l.breakdown?.profit ?? 0) }
        : null,
    })
  }
  return out
}

export function foldDeclaredCarry(d: DeclaredDistribution, recipients: Set<string>): DeclaredDistribution {
  if (recipients.size === 0 || !d.lines.some(l => recipients.has(l.lpEntityId))) return d
  return { ...d, lines: foldDeclaredLines(d.lines, recipients) }
}

/** The notice review's partners, recipients folded into one row with no recipient or draft link. */
export function foldNoticePartners<P extends { lpEntityId: string; name: string; amount: number; capital: number; carry: number; alreadyPublished: boolean; to: string | null; cc: string[]; via: 'portal' | 'contact' | null; unreachable: string | null }>(
  partners: P[], recipients: Set<string>,
): P[] {
  const folded = partners.filter(p => recipients.has(p.lpEntityId))
  if (folded.length === 0) return partners
  const sum = (f: (p: P) => number) => roundCents(folded.reduce((s, p) => s + f(p), 0))
  return [
    ...partners.filter(p => !recipients.has(p.lpEntityId)),
    {
      ...folded[0], lpEntityId: COMBINED_RECIPIENTS_ID, name: COMBINED_RECIPIENTS_NAME,
      amount: sum(p => p.amount), capital: sum(p => p.capital), carry: sum(p => p.carry),
      alreadyPublished: folded.every(p => p.alreadyPublished), to: null, cc: [], via: null, unreachable: null,
    },
  ]
}
