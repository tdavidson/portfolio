import type { ActionDeps, PreviewResult } from './types'
import { proRataCall, issueCapitalCall } from '@/lib/accounting/capital-calls'
import { loadOwnership, loadEntityNames } from '@/lib/accounting/load'
import { resolveVehicle } from '@/lib/accounting/agent-tools'

export interface IssueCapitalCallInput {
  vehicle?: string
  callDate: string
  description?: string | null
  /** Fund-wide amount to split across LPs pro-rata by commitment. */
  total: number
}

/**
 * Read-only preview of a fund-wide capital call: resolve the vehicle, compute the per-LP pro-rata
 * split by commitment, and surface each LP's commitment + amount and the rounded total — WITHOUT
 * posting anything. `proRataCall` and the ownership/name loads are all reads.
 */
export async function previewIssueCapitalCall(deps: ActionDeps, input: IssueCapitalCallInput): Promise<PreviewResult> {
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })

  const [lines, owners, names] = await Promise.all([
    proRataCall(deps.admin, deps.fundId, group, input.total),
    loadOwnership(deps.admin, deps.fundId, group),
    loadEntityNames(deps.admin, deps.fundId, group),
  ])
  const commitmentByLp = new Map(owners.map(o => [o.lpEntityId, o.commitment]))
  const perLp = lines.map(l => ({
    lp: names.get(l.lpEntityId) ?? l.lpEntityId,
    commitment: commitmentByLp.get(l.lpEntityId) ?? 0,
    amount: l.amount,
  }))
  const total = lines.reduce((s, l) => s + l.amount, 0)

  return {
    summary: `Issue a ${input.total} capital call across ${lines.length} LP${lines.length === 1 ? '' : 's'} on ${input.callDate}`,
    details: { vehicle: group, callDate: input.callDate, total, perLp },
  }
}

/**
 * Execute the call: recompute the pro-rata split from LIVE commitments (so a stale preview can't
 * post outdated amounts) and issue it through the same `issueCapitalCall` path the accounting UI
 * uses. Posts the receivable/capital entry and records the call + lines.
 */
export async function executeIssueCapitalCall(deps: ActionDeps, input: IssueCapitalCallInput): Promise<{ callId: string }> {
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const lines = await proRataCall(deps.admin, deps.fundId, group, input.total)
  const result = await issueCapitalCall(deps.admin, deps.fundId, group, deps.userId, {
    callDate: input.callDate,
    description: input.description ?? null,
    scope: 'fund_wide',
    lines,
  })
  if ('error' in result) throw new Error(result.error)
  return { callId: result.callId }
}
