// Handlers for the GP LINK tools (gp-link-tools-manifest.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { gpsOfVehicle, loadVehicleGpLinks, removeVehicleGpLink, setVehicleGpLink } from '@/lib/accounting/gp-links'
import { loadEntityNames } from '@/lib/accounting/load'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { canSeeVehicle } from '@/lib/access/scope'

async function vehicleNames(admin: SupabaseClient, fundId: string): Promise<{ id: string; name: string; kind: string | null }[]> {
  const { data, error } = await (admin as any).from('fund_vehicles').select('id, name, kind').eq('fund_id', fundId)
  if (error) throw new Error(`fund_vehicles read failed: ${error.message}`)
  return ((data as any[]) ?? []).map(v => ({ id: v.id as string, name: v.name as string, kind: (v.kind as string | null) ?? null }))
}

/** A partner named by id or by name (case-insensitive), among the vehicle's partners. */
export function resolvePartner(partners: Map<string, string>, ref: string): string | null {
  if (partners.has(ref)) return ref
  const want = ref.trim().toLowerCase()
  const hits = Array.from(partners.entries()).filter(([, name]) => name.trim().toLowerCase() === want)
  return hits.length === 1 ? hits[0][0] : null
}

/** The served vehicle and the GP entity a call names, refused when either is missing or hidden. */
async function resolveLink({ admin, fundId, portfolioGroup, access }: AgentToolContext, input: any) {
  const servedId = await vehicleIdByName(admin, fundId, portfolioGroup)
  if (!servedId) throw new Error(`No vehicle named ${portfolioGroup}.`)
  const ref = String(input?.gp_vehicle ?? '').trim()
  if (!ref) throw new Error('gp_vehicle is required.')
  const vehicles = await vehicleNames(admin, fundId)
  const gpId = vehicles.find(v => v.id === ref)?.id ?? (await vehicleIdByName(admin, fundId, ref))
  if (!gpId || !canSeeVehicle(access, gpId)) throw new Error(`No entity named ${ref} that you can see.`)
  return { servedId, gpId, gpName: vehicles.find(v => v.id === gpId)?.name ?? ref }
}

export const GP_LINK_HANDLERS: Record<string, AgentToolHandler> = {
  gp_links: async ({ admin, fundId, portfolioGroup, access }: AgentToolContext) => {
    const servedId = await vehicleIdByName(admin, fundId, portfolioGroup)
    if (!servedId) throw new Error(`No vehicle named ${portfolioGroup}.`)
    const [links, vehicles, partners] = await Promise.all([
      loadVehicleGpLinks(admin, fundId),
      vehicleNames(admin, fundId),
      loadEntityNames(admin, fundId, portfolioGroup),
    ])
    const nameOf = new Map(vehicles.map(v => [v.id, v.name]))
    return {
      vehicle: portfolioGroup,
      links: gpsOfVehicle(links, servedId).map(l => ({
        gpVehicle: nameOf.get(l.gpVehicleId) ?? l.gpVehicleId,
        gpVehicleId: l.gpVehicleId,
        partner: l.lpEntityId ? (partners.get(l.lpEntityId) ?? l.lpEntityId) : null,
        partnerId: l.lpEntityId,
      })),
      candidates: vehicles
        .filter(v => (v.kind === 'associate' || v.kind === 'gp') && v.id !== servedId && canSeeVehicle(access, v.id))
        .map(v => ({ id: v.id, name: v.name })),
      partners: Array.from(partners.entries()).map(([id, name]) => ({ id, name })),
    }
  },

  set_gp_link: async (ctx: AgentToolContext, input: any) => {
    const { admin, fundId, portfolioGroup } = ctx
    const { servedId, gpId, gpName } = await resolveLink(ctx, input)

    let lpEntityId: string | null = null
    if (input?.partner) {
      const partners = await loadEntityNames(admin, fundId, portfolioGroup)
      lpEntityId = resolvePartner(partners, String(input.partner))
      if (!lpEntityId) {
        throw new Error(
          `${input.partner} is not one partner of ${portfolioGroup}. Partners: ` +
          (Array.from(partners.values()).join(', ') || 'none') + '. Add it with add_partner first if it is missing.',
        )
      }
    }
    const refusal = await setVehicleGpLink(admin, fundId, { servedVehicleId: servedId, gpVehicleId: gpId, lpEntityId })
    if (refusal) throw new Error(refusal)
    return { vehicle: portfolioGroup, gpVehicle: gpName, partnerId: lpEntityId, linked: true }
  },

  remove_gp_link: async (ctx: AgentToolContext, input: any) => {
    const { servedId, gpId, gpName } = await resolveLink(ctx, input)
    const removed = await removeVehicleGpLink(ctx.admin, ctx.fundId, servedId, gpId)
    return { vehicle: ctx.portfolioGroup, gpVehicle: gpName, removed: removed > 0 }
  },
}
