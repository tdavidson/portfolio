// Admin-reported vehicles, staged for a person to approve: what stage_admin_figures and
// set_vehicle_record_source stage. Applied through lib/admin-reporting/store.ts, the one write path,
// so an approved pull is checked again against the partners as they are at that moment.
//
// Saving is split from pulling on purpose: the pull reads the administrator with the ASKING member's
// own connection, and approval may come from someone without one. So the figures travel in the
// staged args, exactly as pulled.

import type { ActionDeps, PreviewResult } from './types'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { previewAdminPull, saveAdminPull, setVehicleRecordSource } from '@/lib/admin-reporting/store'
import { loadVehicleRecordSource } from '@/lib/admin-reporting/load'

const money = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const explained = (input: { explanation?: string }) => (input?.explanation ? { explanation: String(input.explanation).slice(0, 2000) } : {})

async function vehicleOf(deps: ActionDeps, input: { vehicle?: string }) {
  const name = await resolveVehicle(deps.admin, deps.fundId, input?.vehicle, { access: deps.access })
  const id = await vehicleIdByName(deps.admin, deps.fundId, name)
  if (!id) throw new Error(`No vehicle named "${name}".`)
  return { id, name }
}

export async function previewApplyAdminFigures(deps: ActionDeps, input: any): Promise<PreviewResult> {
  const vehicle = await vehicleOf(deps, input)
  const source = await loadVehicleRecordSource(deps.admin, deps.fundId, vehicle.id)
  if (source.recordSource !== 'admin') {
    throw new Error(`${vehicle.name} keeps its own books. Set it to report its administrator's figures first (set_vehicle_record_source).`)
  }
  const checked = await previewAdminPull(deps.admin, deps.fundId, vehicle, input)
  if (!checked.ok) throw new Error(checked.error)
  const { figures, flags } = checked.value
  if (flags.blocking.length) throw new Error(`Not staged: ${flags.blocking.join(' ')}`)
  const sum = (k: 'commitment' | 'paidIn' | 'distributions' | 'nav') =>
    Math.round(figures.positions.reduce((s, p) => s + (p[k] ?? 0), 0) * 100) / 100
  return {
    summary: `Save ${figures.source}'s figures for ${vehicle.name} as of ${figures.asOf} (${figures.positions.length} partners)`,
    details: {
      vehicle: vehicle.name,
      asOf: figures.asOf,
      source: figures.source,
      partners: figures.positions.length,
      totals: { commitment: money(sum('commitment')), paidIn: money(sum('paidIn')), distributions: money(sum('distributions')), nav: money(sum('nav')) },
      fund: figures.fund,
      ...(flags.warnings.length ? { warnings: flags.warnings } : {}),
      ...(flags.changes.length ? { changes: flags.changes.slice(0, 50) } : {}),
      effect: `Replaces any figures saved for ${figures.asOf}. The LP report cards show them as stated; nothing is recalculated.`,
      ...explained(input),
    },
  }
}

export async function executeApplyAdminFigures(deps: ActionDeps, input: any): Promise<Record<string, unknown>> {
  const vehicle = await vehicleOf(deps, input)
  const saved = await saveAdminPull(deps.admin, {
    // The vehicle was resolved with the approver's access above, so no further name check is needed.
    fundId: deps.fundId, userId: deps.userId, vehicleNames: null, channel: 'assistant',
  }, vehicle, input)
  if (!saved.ok) throw new Error(saved.error)
  return { ...saved.value }
}

export async function previewSetVehicleRecordSource(deps: ActionDeps, input: any): Promise<PreviewResult> {
  const vehicle = await vehicleOf(deps, input)
  const before = await loadVehicleRecordSource(deps.admin, deps.fundId, vehicle.id)
  const to = input?.record_source
  if (to !== 'books' && to !== 'admin') throw new Error('record_source must be books or admin')
  if (to === 'admin' && !['carta', 'csv', 'other'].includes(String(input?.provider ?? ''))) throw new Error('provider must be carta, csv or other')
  if (to === 'admin' && input?.provider === 'carta' && !String(input?.fund_ref ?? '').trim()) throw new Error("fund_ref is required for Carta: the fund's id at Carta")
  return {
    summary: to === 'admin'
      ? `Report ${vehicle.name} from its administrator's figures (${input.provider})`
      : `Report ${vehicle.name} from the app's own books`,
    details: {
      vehicle: vehicle.name,
      before,
      after: { recordSource: to, provider: to === 'admin' ? input.provider : null, fundRef: to === 'admin' ? input.fund_ref ?? null : null },
      effect: to === 'admin'
        ? "The LP report cards show the administrator's saved figures as stated. Nothing on the books changes or is deleted."
        : 'The LP report cards go back to the books. Saved administrator figures are kept.',
      ...explained(input),
    },
  }
}

export async function executeSetVehicleRecordSource(deps: ActionDeps, input: any): Promise<Record<string, unknown>> {
  const vehicle = await vehicleOf(deps, input)
  const done = await setVehicleRecordSource(deps.admin, deps.fundId, vehicle.id, {
    recordSource: input?.record_source, provider: input?.provider, fundRef: input?.fund_ref,
  })
  if (!done.ok) throw new Error(done.error)
  return { vehicle: vehicle.name, ...done.value }
}
