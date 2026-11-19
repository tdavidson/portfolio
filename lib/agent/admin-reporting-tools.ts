// Handlers for the ADMIN-REPORTED VEHICLE tools (admin-reporting-tools-manifest.ts).

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadVehicleRecordSource } from '@/lib/admin-reporting/load'
import { listAdminPulls, previewAdminPull } from '@/lib/admin-reporting/store'
import { pullFromCarta } from '@/lib/admin-reporting/carta'

const staged = (name: string): AgentToolHandler => async () => {
  throw new Error(`${name} is always staged for approval; it cannot run directly.`)
}

async function vehicleIdOf(ctx: AgentToolContext): Promise<string> {
  const id = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
  if (!id) throw new Error(`No vehicle named "${ctx.portfolioGroup}".`)
  return id
}

export const ADMIN_REPORTING_HANDLERS: Record<string, AgentToolHandler> = {
  admin_pulls: async (ctx: AgentToolContext) => {
    const vehicleId = await vehicleIdOf(ctx)
    const [source, pulls] = await Promise.all([
      loadVehicleRecordSource(ctx.admin, ctx.fundId, vehicleId),
      listAdminPulls(ctx.admin, ctx.fundId, vehicleId),
    ])
    return {
      vehicle: ctx.portfolioGroup,
      ...source,
      pulls,
      ...(source.recordSource === 'books'
        ? { note: `${ctx.portfolioGroup} keeps its own books. set_vehicle_record_source makes it report its administrator's figures.` }
        : {}),
    }
  },

  pull_admin_figures: async (ctx: AgentToolContext, input: { as_of?: string }) => {
    const vehicleId = await vehicleIdOf(ctx)
    const source = await loadVehicleRecordSource(ctx.admin, ctx.fundId, vehicleId)
    if (source.recordSource !== 'admin') {
      throw new Error(`${ctx.portfolioGroup} keeps its own books. Set it to report its administrator's figures first (set_vehicle_record_source).`)
    }
    if (source.provider !== 'carta') {
      throw new Error(`${ctx.portfolioGroup}'s administrator has no direct pull. Give its figures to stage_admin_figures as the administrator states them.`)
    }
    if (!ctx.userId) throw new Error('A Carta pull reads with your own Carta connection, so it needs a signed-in member, not a fund key.')
    const pulled = await pullFromCarta(ctx.admin, ctx.userId, source.fundRef ?? '', String(input?.as_of ?? ''))
    if (!pulled.ok) throw new Error(pulled.error)
    const checked = await previewAdminPull(ctx.admin, ctx.fundId, { id: vehicleId, name: ctx.portfolioGroup }, pulled.input)
    if (!checked.ok) throw new Error(checked.error)
    const { flags, ready } = checked.value
    return {
      vehicle: ctx.portfolioGroup,
      ready,
      flags: { blocking: flags.blocking, warnings: flags.warnings, changes: flags.changes },
      // Pass exactly this to stage_admin_figures; lp_entity_id is filled in where a partner was matched.
      figures: {
        ...pulled.input,
        positions: pulled.input.positions.map((p, i) => ({ ...p, ...(flags.matches[i]?.lpEntityId ? { lp_entity_id: flags.matches[i].lpEntityId } : {}) })),
      },
      next: ready
        ? 'Show the person the totals and the fund figures, then stage_admin_figures with `figures` as given.'
        : 'Resolve the blocking items first (add or match the partners), then pull again.',
    }
  },

  // Always staged as their pending actions (the manifest's `stagesAs`), so these never run.
  stage_admin_figures: staged('stage_admin_figures'),
  set_vehicle_record_source: staged('set_vehicle_record_source'),
}
