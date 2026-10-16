// The LP register's records from chat and the API (the `lp_*` record tools in lp-tools-manifest.ts).
// Each resolves names to ids within the caller's LP scope, then calls the function the web route
// calls (lib/lps/records.ts). Writes are staged for approval when they come from a chat; the
// investor and entity tools are admin-only (lib/access/admin-only.ts), as on the Investors page.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { fetchAllRows } from '@/lib/accounting/load'
import { commitmentsAsOf } from '@/lib/accounting/terms'
import { unwrap } from '@/lib/service-outcome'
import {
  addCommitmentChange, correctCommitmentEvent, createEntity, createInvestor, updateEntity, updateEntityProfile, updateInvestor,
} from '@/lib/lps/records'
import { loadIdentities, lpToolScope, resolveLp, type EntityIdentity } from './lp-tools'
import { requireUser } from './deals-tools'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** One investor of this fund, by id or name. */
export async function resolveInvestor(admin: SupabaseClient, fundId: string, ref: string): Promise<{ id: string; name: string }> {
  const needle = ref.trim().toLowerCase()
  if (!needle) throw new Error('Name the investor.')
  const { data } = await (admin as any).from('lp_investors').select('id, name').eq('fund_id', fundId)
  const rows = ((data ?? []) as { id: string; name: string }[])
  const byId = rows.find(r => r.id === ref.trim())
  if (byId) return byId
  const exact = rows.filter(r => r.name.trim().toLowerCase() === needle)
  if (exact.length === 1) return exact[0]
  const near = exact.length ? exact : rows.filter(r => r.name.toLowerCase().includes(needle))
  if (near.length === 1) return near[0]
  if (near.length > 1) throw new Error(`"${ref}" matches ${near.length} investors (${near.map(r => r.name).join(', ')}). Pass one.`)
  throw new Error(`No investor matching "${ref}" in this fund.`)
}

/** Exactly one LP entity the caller can see. */
export async function resolveEntity(ctx: Pick<AgentToolContext, 'admin' | 'fundId' | 'access'>, ref: unknown): Promise<EntityIdentity> {
  const scope = await lpToolScope(ctx.admin, ctx.access)
  const matches = resolveLp(await loadIdentities(ctx.admin, ctx.fundId, scope.entityIds), String(ref ?? ''))
  if (matches.length > 1) {
    throw new Error(`"${ref}" matches ${matches.length} entities (${matches.map(m => m.entityName).join(', ')}). Pass one.`)
  }
  return matches[0]
}

function isoDate(v: unknown, label: string): string {
  const s = String(v ?? '')
  if (!ISO_DATE.test(s)) throw new Error(`${label} must be an ISO date (YYYY-MM-DD)`)
  return s
}

export const LP_RECORD_HANDLERS: Record<string, AgentToolHandler> = {
  lp_commitments: async (ctx: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, String(input?.vehicle ?? '') || undefined, { access: ctx.access })
    const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, vehicle)
    const asOf = input?.as_of ? isoDate(input.as_of, 'as_of') : null
    const scope = await lpToolScope(ctx.admin, ctx.access)
    const identities = await loadIdentities(ctx.admin, ctx.fundId, scope.entityIds)
    const only = input?.lp ? (await resolveEntity(ctx, input.lp)).entityId : null
    // Every event, paged: a commitment is the SUM of its events, so a capped read understates it.
    const data = await fetchAllRows<any>((f, t) => (ctx.admin as any).from('commitment_events')
      .select('id, lp_entity_id, effective_date, amount, kind, transfer_id, counterparty_entity_id, memo')
      .eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).order('effective_date', { ascending: true }).order('id', { ascending: true }).range(f, t))
    // Only the caller's LPs, as everywhere else on the register.
    const rows = data.filter(e => identities.has(e.lp_entity_id) && (!only || e.lp_entity_id === only))
    const name = (id: string | null) => (id ? identities.get(id)?.entityName ?? 'another partner' : null)
    const commitments = commitmentsAsOf(
      rows.map(e => ({ lpEntityId: e.lp_entity_id, effectiveDate: e.effective_date, amount: Number(e.amount), kind: e.kind })),
      asOf,
    )
    return {
      vehicle,
      as_of: asOf ?? 'today',
      commitments: [...commitments.entries()].map(([id, amount]) => ({ lp: name(id), lp_entity_id: id, commitment: amount }))
        .sort((a, b) => String(a.lp).localeCompare(String(b.lp))),
      events: rows.map(e => ({
        id: e.id, lp: name(e.lp_entity_id), date: e.effective_date, amount: Number(e.amount), kind: e.kind,
        transfer_with: name(e.counterparty_entity_id), memo: e.memo ?? null,
      })).reverse(),
    }
  },

  lp_create_investor: async ({ admin, fundId }: AgentToolContext, input: any) => {
    const row = unwrap(await createInvestor(admin, fundId, input?.name))
    return { investor: { id: row.id, name: row.name }, next: 'Add their legal entities with lp_create_entity, then a commitment with add_partner.' }
  },

  lp_update_investor: async ({ admin, fundId }: AgentToolContext, input: any) => {
    const investor = await resolveInvestor(admin, fundId, String(input?.investor ?? ''))
    let parentId: string | null | undefined
    if (input?.parent !== undefined) parentId = input.parent ? (await resolveInvestor(admin, fundId, String(input.parent))).id : null
    if (input?.name === undefined && parentId === undefined) throw new Error('Pass a new name or a parent.')
    const out = await updateInvestor(admin, fundId, investor.id, { name: input?.name, parentId })
    if (!out.ok && out.error === 'duplicate_name') {
      throw new Error(`Another investor is already named "${String(input.name).trim()}". Merging investors is done on the Investors page.`)
    }
    const row = unwrap(out)
    return { investor: { id: row.id, name: row.name, parent_id: row.parent_id ?? null } }
  },

  lp_create_entity: async ({ admin, fundId }: AgentToolContext, input: any) => {
    const investor = await resolveInvestor(admin, fundId, String(input?.investor ?? ''))
    const row = unwrap(await createEntity(admin, fundId, { investorId: investor.id, entityName: input?.entity_name }))
    return { entity: { id: row.id, name: row.entity_name }, investor: investor.name }
  },

  lp_update_entity: async (ctx: AgentToolContext, input: any) => {
    const entity = await resolveEntity(ctx, input?.lp)
    const investorId = input?.investor ? (await resolveInvestor(ctx.admin, ctx.fundId, String(input.investor))).id : undefined
    const row = unwrap(await updateEntity(ctx.admin, ctx.fundId, entity.entityId, { investorId, entityName: input?.name }))
    return { entity: { id: row.id, name: row.entity_name, investor_id: row.investor_id } }
  },

  lp_update_profile: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const entity = await resolveEntity(ctx, input?.lp)
    const scope = await lpToolScope(ctx.admin, ctx.access)
    return unwrap(await updateEntityProfile(
      ctx.admin, { fundId: ctx.fundId, userId, visibleEntityIds: scope.entityIds }, entity.entityId,
      { entity: input?.entity, investor: input?.contact },
    ))
  },

  lp_record_commitment: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, String(input?.vehicle ?? '') || undefined, { access: ctx.access })
    const lp = await resolveEntity(ctx, input?.lp)
    const from = input?.from_lp ? await resolveEntity(ctx, input.from_lp) : null
    const amount = Number(input?.amount)
    unwrap(await addCommitmentChange(ctx.admin, { fundId: ctx.fundId, userId }, vehicle, {
      lpEntityId: lp.entityId,
      effectiveDate: isoDate(input?.effective_date, 'effective_date'),
      amount,
      counterpartyEntityId: from?.entityId ?? null,
      memo: input?.memo ? String(input.memo) : null,
    }))
    return {
      recorded: from ? `Transfer of ${amount} from ${from.entityName} to ${lp.entityName}` : `${amount > 0 ? 'Increase' : 'Decrease'} of ${Math.abs(amount)} for ${lp.entityName}`,
      vehicle, effective_date: input.effective_date,
    }
  },

  lp_correct_commitment: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, String(input?.vehicle ?? '') || undefined, { access: ctx.access })
    // Only an event on one of the caller's LPs.
    const scope = await lpToolScope(ctx.admin, ctx.access)
    if (scope.entityIds !== null) {
      const { data: ev } = await (ctx.admin as any).from('commitment_events').select('lp_entity_id').eq('id', String(input?.event_id ?? '')).eq('fund_id', ctx.fundId).maybeSingle()
      if (!ev || !scope.entityIds.includes(ev.lp_entity_id)) throw new Error('Not found')
    }
    unwrap(await correctCommitmentEvent(ctx.admin, { fundId: ctx.fundId, userId }, vehicle, String(input?.event_id ?? ''), {
      effectiveDate: input?.effective_date, amount: input?.amount, memo: input?.memo, reason: input?.reason,
    }))
    return { corrected: input.event_id, vehicle }
  },
}
