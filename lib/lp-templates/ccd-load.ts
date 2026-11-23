// Reads what an ILPA Capital Call & Distribution file is built from: the notice register (the same
// frozen lines a notice PDF restates), each partner's commitment, their earlier notices, and the
// charges or deductions booked against this one. Nothing here writes, renders or sends.
//
// Cumulative figures come from the REGISTER, like the notice itself: what each earlier notice
// called or declared, not what has since been paid, so the file says what the partner was told.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadNoticeRegister, type NoticeLine } from '@/lib/accounting/notice-register'
import { lpCapitalSummary, listCapitalCalls } from '@/lib/accounting/capital-calls'
import { listDistributions } from '@/lib/accounting/distributions'
import { callExtras, distributionDeductions } from '@/lib/accounting/call-extras'
import { normalizePurposes } from '@/lib/accounting/capital-call-check'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { roundCents } from '@/lib/accounting/ledger'
import { UNCHARACTERISED } from '@/lib/accounting/distribution-character'
import { documentLetterhead } from '@/lib/vehicle-letterhead'
import type { NoticeKind } from '@/lib/accounting/notice-types'
import { buildCcdNotice, callTransactions, distributionTransactions, type CcdNotice, type CcdTransaction } from './ccd'
import { ILPA_CCD_ATTRIBUTION } from './ccd-types'

const FOOTNOTES = [
  'Prepared from the fund’s notice register. Field names and transaction types are those of the ILPA Capital Call & Distribution Template (v. 2.0).',
  'Unfunded commitment is commitment less capital called on notices up to and including this one. Recallable distributions and expired or released commitments are not yet recorded, so distribution lines state no impact on unfunded.',
  'Amounts distributed to limited partners are stated net of carried interest.',
  ILPA_CCD_ATTRIBUTION,
]

/** Is `other` an earlier notice than this one? Same-date notices count only when both are numbered. */
function isEarlier(other: { date: string; number: number | null }, self: { date: string; number: number | null }): boolean {
  if (other.date !== self.date) return other.date < self.date
  return other.number != null && self.number != null && other.number < self.number
}

export async function loadCcdNotices(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  kind: NoticeKind,
  id: string,
  lpEntityId?: string | null,
): Promise<{ ok: true; notices: CcdNotice[]; fileStem: string } | { ok: false; error: string; status: number }> {
  const reg = await loadNoticeRegister(admin, fundId, group, kind, id)
  if ('error' in reg) return { ok: false, error: reg.error, status: reg.status }
  const targets = lpEntityId ? reg.lines.filter(l => l.lpEntityId === lpEntityId) : reg.lines
  if (targets.length === 0) return { ok: false, error: 'That partner has no line on this notice', status: 404 }

  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [fundRes, settingsRes, summary, calls, distributions] = await Promise.all([
    admin.from('funds' as any).select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency').eq('fund_id', fundId).maybeSingle(),
    lpCapitalSummary(admin, fundId, group),
    listCapitalCalls(admin, fundId, group),
    listDistributions(admin, fundId, group),
  ])
  const letterhead = await documentLetterhead(admin, fundId, (fundRes as any).data, [group])
  const currency = (settingsRes as any).data?.currency || 'USD'
  const byLp = new Map(summary.map(r => [r.lpEntityId, r]))
  const fundSize = roundCents(summary.reduce((s, r) => s + (r.commitment || 0), 0))
  const gpCommitment = roundCents(summary.filter(r => r.partnerClass === 'gp').reduce((s, r) => s + (r.commitment || 0), 0))
  const self = { date: reg.noticeDate, number: reg.numberLabel }

  const contributionsPrior = new Map<string, number>()
  for (const c of calls) {
    if (kind === 'capital_call' && c.id === id) continue
    if (kind === 'capital_call' ? !isEarlier({ date: c.callDate, number: c.callNumber }, self) : c.callDate > reg.noticeDate) continue
    for (const l of c.lines) contributionsPrior.set(l.lpEntityId, roundCents((contributionsPrior.get(l.lpEntityId) ?? 0) + l.amount))
  }
  const distributionsPrior = new Map<string, number>()
  for (const d of distributions) {
    if (kind === 'distribution' && d.distributionId === id) continue
    if (kind === 'distribution' ? !(d.date < reg.noticeDate) : d.date > reg.noticeDate) continue
    for (const l of d.lines) distributionsPrior.set(l.lpEntityId, roundCents((distributionsPrior.get(l.lpEntityId) ?? 0) + l.amount))
  }

  const noticeTotal = roundCents(reg.lines.reduce((s, l) => s + l.amount, 0))
  let build: (line: NoticeLine) => CcdTransaction[]

  if (kind === 'capital_call') {
    const [{ data: callRow }, extras] = await Promise.all([
      (admin as any).from('capital_calls').select('purposes').eq('id', id).eq('fund_id', fundId).maybeSingle(),
      callExtras(admin, fundId, vehicleId, [id]),
    ])
    const purposes = normalizePurposes((callRow as any)?.purposes)
    const charges = extras.get(id)?.charges
    build = line => callTransactions({
      amount: line.amount,
      description: reg.description,
      purposes,
      charges: charges?.get(line.lpEntityId) ?? [],
    })
  } else {
    const declared = distributions.find(d => d.distributionId === id)
    const deductions = (await distributionDeductions(admin, fundId, vehicleId, [id])).get(id)
    const lineById = new Map((declared?.lines ?? []).map(l => [l.id, l]))
    // One notice per partner: a GP's LP line and carry line are separate transactions on it, and
    // the deductions are taken once.
    build = line => (line.parts ?? [{ lineId: line.id, role: line.role, amount: line.amount, returnOfCapital: null, preferred: null, profit: null }])
      .flatMap((part, i) => distributionTransactions({
        amount: part.amount,
        role: part.role,
        description: reg.description,
        kind: declared?.kind ?? 'cash',
        character: lineById.get(part.lineId)?.character ?? UNCHARACTERISED,
        waterfallReturnOfCapital: part.role !== 'lp'
          ? null
          : part.returnOfCapital != null
            ? part.returnOfCapital
            : reg.tiers && reg.tiers.lpTotal > 0
              ? roundCents(reg.tiers.returnOfCapital * (part.amount / reg.tiers.lpTotal))
              : null,
        deductions: i === 0 ? deductions?.get(line.lpEntityId) ?? [] : [],
      }))
  }

  const notices = targets.map(line => {
    const row = byLp.get(line.lpEntityId)
    return buildCcdNotice({
      kind,
      noticeDate: reg.noticeDate,
      dueDate: reg.dueDate,
      fundName: letterhead.name,
      currency,
      fundSize,
      gpCommitment,
      noticeTotal,
      lp: {
        id: line.lpEntityId,
        name: row?.name ?? line.lpEntityId,
        commitment: row?.commitment ?? 0,
        contributionsPrior: contributionsPrior.get(line.lpEntityId) ?? 0,
        distributionsPrior: distributionsPrior.get(line.lpEntityId) ?? 0,
      },
      transactions: build(line),
      footnotes: FOOTNOTES,
    })
  })

  const noun = kind === 'capital_call' ? 'capital-call' : 'distribution'
  const fileStem = `ilpa-${noun}-${reg.numberLabel ?? ''}-${reg.noticeDate}-${group}`.replace(/[^a-zA-Z0-9\-]+/g, '-').replace(/-+/g, '-')
  return { ok: true, notices, fileStem }
}
