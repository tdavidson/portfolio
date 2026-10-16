// The LP register's records: investors, their entities, an entity's profile and contact, and
// commitment changes. Shared by the web routes (app/api/lps/investors, app/api/lps/entities,
// app/api/lps/entities/profile, app/api/accounting/commitments) and the `lp_*` agent tools, so both
// refuse the same things in the same words.
//
// Who may call: the caller has checked the grant (route-domains / the tool's access domain) and,
// where the web requires an admin, the role. These functions check what the record itself decides:
// that it is this fund's, that a name is unique, that a commitment change is coherent.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'
import { parseEntityProfile, parseInvestorContact } from '@/lib/lp-profile'
import { logOnboardingEvent } from '@/lib/lp-onboarding-audit'
import { auditReason, recordAudit } from '@/lib/audit/events'
import { recordCommitmentChange } from '@/lib/accounting/terms'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { ACTUAL_BOOK } from '@/lib/accounting/books'

type Row = Record<string, any>
const MAX_NAME = 500

function cleanName(raw: unknown, field: string): Outcome<string> {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) return fail(400, `${field} is required`)
  if (name.length > MAX_NAME) return fail(400, `${field} too long (max ${MAX_NAME} chars)`)
  return done(name)
}

async function investorInFund(admin: SupabaseClient, fundId: string, id: string): Promise<boolean> {
  const { data } = await (admin as any).from('lp_investors').select('id').eq('id', id).eq('fund_id', fundId).maybeSingle()
  return !!data
}

export async function createInvestor(admin: SupabaseClient, fundId: string, rawName: unknown): Promise<Outcome<Row>> {
  const name = cleanName(rawName, 'name')
  if (!name.ok) return name
  const { data, error } = await (admin as any).from('lp_investors').insert({ fund_id: fundId, name: name.value }).select('*').single()
  if (error) {
    if (/unique|duplicate/i.test(error.message ?? '')) return fail(409, `An investor named "${name.value}" already exists.`)
    return dbFail(error, 'lp-investors-create')
  }
  return done(data)
}

/** Rename an investor and/or set its parent. A name taken by another investor is a 409 naming it, for a merge. */
export async function updateInvestor(
  admin: SupabaseClient, fundId: string, id: string, input: { name?: unknown; parentId?: unknown },
): Promise<Outcome<Row>> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  let name: string | undefined
  if (input.name !== undefined) {
    const n = cleanName(input.name, 'name')
    if (!n.ok) return fail(400, n.error === 'name is required' ? 'name cannot be empty' : n.error)
    name = n.value
    updates.name = name
  }
  if (input.parentId !== undefined) {
    if (input.parentId !== null && typeof input.parentId !== 'string') return fail(400, 'parentId must be a string or null')
    if (input.parentId === id) return fail(400, 'An investor cannot be its own parent')
    if (typeof input.parentId === 'string' && !(await investorInFund(admin, fundId, input.parentId))) return fail(404, 'Parent investor not found')
    updates.parent_id = input.parentId
  }
  const { data, error } = await (admin as any).from('lp_investors').update(updates).eq('id', id).eq('fund_id', fundId).select('*').single()
  if (error) {
    if (/unique|duplicate/i.test(error.message ?? '')) {
      // The conflicting investor, so the caller can offer a merge instead of a hard error.
      let conflictId: string | null = null
      if (name !== undefined) {
        const { data: conflict } = await (admin as any).from('lp_investors').select('id')
          .eq('fund_id', fundId).eq('name', name).neq('id', id).maybeSingle()
        conflictId = conflict?.id ?? null
      }
      return fail(409, 'duplicate_name', { conflictId, sourceId: id })
    }
    return dbFail(error, 'lp-investors-update')
  }
  return done(data)
}

export async function createEntity(
  admin: SupabaseClient, fundId: string, input: { investorId: unknown; entityName: unknown },
): Promise<Outcome<Row>> {
  if (typeof input.investorId !== 'string' || !input.investorId) return fail(400, 'investorId is required')
  const name = cleanName(input.entityName, 'entityName')
  if (!name.ok) return name
  if (!(await investorInFund(admin, fundId, input.investorId))) return fail(404, 'Investor not found')
  const { data, error } = await (admin as any).from('lp_entities')
    .insert({ fund_id: fundId, investor_id: input.investorId, entity_name: name.value }).select('*').single()
  if (error) return dbFail(error, 'lp-entities-create')
  return done(data)
}

/**
 * Move an entity to another investor and/or rename it. A rename also renames the investor when
 * that name is free (investor names are unique), so the LP report keeps the same label.
 */
export async function updateEntity(
  admin: SupabaseClient, fundId: string, id: string, input: { investorId?: unknown; entityName?: unknown },
): Promise<Outcome<Row>> {
  const db = admin as any
  const rename = typeof input.entityName === 'string' ? input.entityName.trim() : ''
  const investorId = typeof input.investorId === 'string' ? input.investorId : ''
  if (!investorId && !rename) return fail(400, 'investorId or entityName is required')
  if (rename.length > MAX_NAME) return fail(400, `entityName too long (max ${MAX_NAME} chars)`)
  const { data: existing } = await db.from('lp_entities').select('id').eq('id', id).eq('fund_id', fundId).maybeSingle()
  if (!existing) return fail(404, 'Entity not found')

  if (investorId) {
    if (!(await investorInFund(admin, fundId, investorId))) return fail(404, 'Investor not found')
    const { error } = await db.from('lp_entities').update({ investor_id: investorId }).eq('id', id).eq('fund_id', fundId)
    if (error) return dbFail(error, 'lp-entities-reassign')
  }
  if (rename) {
    const { data: ent, error } = await db.from('lp_entities').update({ entity_name: rename })
      .eq('id', id).eq('fund_id', fundId).select('id, investor_id').single()
    if (error) return dbFail(error, 'lp-entities-rename')
    const invId = ent?.investor_id
    if (invId) {
      const { data: clash } = await db.from('lp_investors').select('id').eq('fund_id', fundId).eq('name', rename).neq('id', invId).maybeSingle()
      if (!clash) {
        await db.from('lp_investors').update({ name: rename, updated_at: new Date().toISOString() }).eq('id', invId).eq('fund_id', fundId)
      }
    }
  }
  const { data } = await db.from('lp_entities').select('*').eq('id', id).eq('fund_id', fundId).single()
  return done(data)
}

/**
 * An entity's profile (the facts a subscription document is filled from) and its investor's
 * relationship contact. Only the keys given change; the investor written is the entity's own.
 * `visibleEntityIds` is the caller's LP scope (null = every entity).
 */
export async function updateEntityProfile(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string; visibleEntityIds: string[] | null },
  entityId: string,
  input: { entity?: unknown; investor?: unknown },
): Promise<Outcome<{ entity: Row; investor: Row }>> {
  const { fundId } = ctx
  const db = admin as any
  if (!entityId) return fail(400, 'lp_entity_id is required')
  if (ctx.visibleEntityIds !== null && !ctx.visibleEntityIds.includes(entityId)) return fail(404, 'Entity not found in your fund')
  const { data: entity } = await db.from('lp_entities').select('id, investor_id, onboarding_excluded').eq('id', entityId).eq('fund_id', fundId).maybeSingle()
  if (!entity) return fail(404, 'Entity not found in your fund')

  const ent = input.entity != null ? parseEntityProfile(input.entity) : null
  if (ent && 'error' in ent) return fail(400, ent.error)
  const inv = input.investor != null ? parseInvestorContact(input.investor) : null
  if (inv && 'error' in inv) return fail(400, inv.error)
  if (!ent && !inv) return fail(400, 'Nothing to change')

  if (ent && Object.keys(ent.patch).length > 0) {
    const { error } = await db.from('lp_entities').update({ ...ent.patch, profile_updated_at: new Date().toISOString() }).eq('id', entityId).eq('fund_id', fundId)
    if (error) return dbFail(error, 'lp-entity-profile')
    if (ent.patch.onboarding_excluded !== undefined && ent.patch.onboarding_excluded !== !!entity.onboarding_excluded) {
      await logOnboardingEvent(admin, { fundId, itemId: null, lpEntityId: entityId, kind: 'all', action: ent.patch.onboarding_excluded ? 'excluded' : 'included', actorUserId: ctx.userId })
    }
  }
  if (inv && Object.keys(inv.patch).length > 0) {
    const { error } = await db.from('lp_investors').update({ ...inv.patch, updated_at: new Date().toISOString() }).eq('id', entity.investor_id).eq('fund_id', fundId)
    if (error) return dbFail(error, 'lp-entity-profile')
  }

  const [{ data: e }, { data: i }] = await Promise.all([
    db.from('lp_entities').select('id, entity_name, entity_type, formation_jurisdiction, address_line1, address_line2, city, region, postal_code, country, notice_email, signatories, profile_notes, profile_updated_at, onboarding_excluded').eq('id', entityId).single(),
    db.from('lp_investors').select('id, name, contact_name, contact_email, contact_phone').eq('id', entity.investor_id).single(),
  ])
  return done({ entity: e, investor: i })
}

export interface CommitmentChange {
  lpEntityId: string
  effectiveDate: string
  amount: number
  /** Present = a transfer of commitment TO lpEntityId FROM this partner. */
  counterpartyEntityId?: string | null
  memo?: string | null
}

/** Record an increase, decrease or transfer of commitment, and audit it. */
export async function addCommitmentChange(
  admin: SupabaseClient, ctx: { fundId: string; userId: string }, group: string, input: CommitmentChange,
): Promise<Outcome<{ ok: true }>> {
  const result = await recordCommitmentChange(admin, ctx.fundId, group, ctx.userId, {
    lpEntityId: input.lpEntityId,
    effectiveDate: input.effectiveDate,
    amount: Number(input.amount),
    counterpartyEntityId: input.counterpartyEntityId ?? null,
    memo: input.memo ?? null,
  })
  if ('error' in result) return fail(400, result.error)
  await recordAudit(admin, {
    fundId: ctx.fundId, vehicleId: await vehicleIdByName(admin, ctx.fundId, group), actorId: ctx.userId,
    action: 'commitment.create', subjectType: 'lp_entity', subjectId: input.lpEntityId ?? null, reason: auditReason(input.memo),
    details: { effectiveDate: input.effectiveDate, amount: Number(input.amount), counterpartyEntityId: input.counterpartyEntityId ?? null },
  })
  return done({ ok: true })
}

/**
 * Correct a recorded commitment event's date, amount or memo. Changing an amount needs a reason,
 * and every edit is audited with the event as it was. A transfer leg refuses an amount change
 * (delete and re-enter) but takes a date or memo on both legs, so the pair stays consistent.
 */
export async function correctCommitmentEvent(
  admin: SupabaseClient, ctx: { fundId: string; userId: string }, group: string,
  id: string, input: { effectiveDate?: unknown; amount?: unknown; memo?: unknown; reason?: unknown },
): Promise<Outcome<{ ok: true }>> {
  const { fundId } = ctx
  const db = admin as any
  if (!id) return fail(400, 'id is required')
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data: row, error: fetchError } = await db.from('commitment_events').select('*')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', id).maybeSingle()
  if (fetchError) return dbFail(fetchError, 'commitments-correct')
  if (!row) return fail(404, 'Not found')

  const reason = auditReason(input.reason)
  if (input.amount !== undefined && Number(input.amount) !== Number(row.amount) && !reason) {
    return fail(400, 'A reason is required to change a recorded commitment amount.')
  }
  if (input.effectiveDate !== undefined && (typeof input.effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate))) {
    return fail(400, 'effectiveDate must be YYYY-MM-DD')
  }
  const audit = () => recordAudit(admin, {
    fundId, vehicleId, actorId: ctx.userId, action: 'commitment.edit', subjectType: 'commitment_event', subjectId: id, reason,
    details: {
      before: { effectiveDate: row.effective_date, amount: Number(row.amount), memo: row.memo ?? null, kind: row.kind, lpEntityId: row.lp_entity_id, transferId: row.transfer_id ?? null },
      after: { effectiveDate: input.effectiveDate, amount: input.amount === undefined ? undefined : Number(input.amount), memo: input.memo },
    },
  })

  const update: Record<string, unknown> = {}
  if (input.effectiveDate !== undefined) update.effective_date = input.effectiveDate
  if (input.memo !== undefined) update.memo = input.memo

  if (row.transfer_id) {
    if (input.amount !== undefined) return fail(400, 'To change a transfer amount, delete it and re-enter the transfer.')
    if (Object.keys(update).length > 0) {
      const { error } = await db.from('commitment_events').update(update).eq('fund_id', fundId).eq('transfer_id', row.transfer_id)
      if (error) return dbFail(error, 'commitments-correct')
      await audit()
    }
    return done({ ok: true })
  }

  if (input.amount !== undefined) {
    const amt = Number(input.amount)
    if (!Number.isFinite(amt) || amt === 0) return fail(400, 'Amount must be a non-zero number')
    update.amount = amt
    // Preserve an 'initial' marker; only a plain increase/decrease flips with the sign.
    update.kind = row.kind === 'initial' ? 'initial' : amt > 0 ? 'increase' : 'decrease'
  }
  if (Object.keys(update).length > 0) {
    const { error } = await db.from('commitment_events').update(update).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', id)
    if (error) return dbFail(error, 'commitments-correct')
    await audit()
  }
  return done({ ok: true })
}

// ── Destructive: delete and merge (admin-only on every surface) ────────────────────────────

/** Delete an investor. Its entities and shares go as the database's foreign keys decide. */
export async function deleteInvestor(admin: SupabaseClient, fundId: string, id: unknown): Promise<Outcome<{ ok: true }>> {
  if (!id) return fail(400, 'id is required')
  const { error } = await (admin as any).from('lp_investors').delete().eq('id', id).eq('fund_id', fundId)
  if (error) return dbFail(error, 'lp-investors-delete')
  return done({ ok: true })
}

/** What an entity has on the books: postings in the actual book, and capital-call lines. */
export async function entityLedgerActivity(admin: SupabaseClient, fundId: string, id: string): Promise<{ postings: number; callLines: number }> {
  const [{ count: postingCount }, { count: callLineCount }] = await Promise.all([
    (admin as any).from('journal_postings')
      .select('id', { count: 'exact', head: true })
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', fundId)
      .eq('lp_entity_id', id),
    (admin as any).from('capital_call_lines')
      .select('id', { count: 'exact', head: true })
      .eq('fund_id', fundId)
      .eq('lp_entity_id', id),
  ])
  return { postings: postingCount ?? 0, callLines: callLineCount ?? 0 }
}

/**
 * Delete an LP entity, refused while it has ledger activity.
 *
 * `chart_of_accounts.lp_entity_id` and `journal_postings.lp_entity_id` are ON DELETE SET NULL. So
 * deleting a partner did not fail — it quietly severed their capital account from them. The
 * postings stayed in the trial balance (the books still balanced!) but vanished from every
 * capital-account computation, which requires both the account AND the posting to carry an
 * lp_entity_id. The sum of partner capital silently stopped equalling equity, and the capital-call
 * register lost its history (those rows cascade-delete).
 *
 * A partner with money on the books is not a row to be deleted. There is no safe way to "undo"
 * them; their history is the fund's history.
 */
export async function deleteEntity(admin: SupabaseClient, fundId: string, id: unknown): Promise<Outcome<{ ok: true }>> {
  if (!id) return fail(400, 'id is required')
  const activity = await entityLedgerActivity(admin, fundId, String(id))
  if (activity.postings > 0 || activity.callLines > 0) {
    return fail(400,
      'That partner has activity in the ledger, so deleting them would silently break the books — ' +
      'their capital postings would stay in the trial balance while disappearing from every capital account. ' +
      'Reverse or reassign their entries first.')
  }
  const { error } = await (admin as any).from('lp_entities').delete().eq('id', id).eq('fund_id', fundId)
  if (error) return dbFail(error, 'lp-entities-delete')
  return done({ ok: true })
}

/** Merge one investor into another: every entity of the source moves to the target, then the source is deleted. */
export async function mergeInvestors(
  admin: SupabaseClient, fundId: string, sourceId: unknown, targetId: unknown,
): Promise<Outcome<{ ok: true; merged: { from: string; into: string } }>> {
  if (!sourceId || !targetId) return fail(400, 'sourceId and targetId are required')
  if (sourceId === targetId) return fail(400, 'Cannot merge investor into itself')
  const db = admin as any
  if (!(await investorInFund(admin, fundId, String(sourceId)))) return fail(404, 'Source investor not found')
  if (!(await investorInFund(admin, fundId, String(targetId)))) return fail(404, 'Target investor not found')

  // Reassign all entities from source investor to target investor
  const { error: reassignErr } = await db.from('lp_entities').update({ investor_id: targetId }).eq('investor_id', sourceId).eq('fund_id', fundId)
  if (reassignErr) return dbFail(reassignErr, 'lp-investors-merge-reassign')

  // Delete the source investor (now has no entities)
  const { error: deleteErr } = await db.from('lp_investors').delete().eq('id', sourceId).eq('fund_id', fundId)
  if (deleteErr) return dbFail(deleteErr, 'lp-investors-merge-delete')

  return done({ ok: true, merged: { from: String(sourceId), into: String(targetId) } })
}

/**
 * Remove a wrongly-entered commitment event. A transfer leg deletes BOTH legs sharing its
 * transfer_id, so the fund's total commitment can't drift. Needs a reason; the deleted event,
 * whole, is audited as the record that it ever existed.
 */
export async function deleteCommitmentEvent(
  admin: SupabaseClient, ctx: { fundId: string; userId: string }, group: string, id: unknown, rawReason: unknown,
): Promise<Outcome<{ ok: true; legs: number }>> {
  const { fundId } = ctx
  const db = admin as any
  if (!id) return fail(400, 'id is required')
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data: row, error: fetchError } = await db.from('commitment_events').select('*')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', id).maybeSingle()
  if (fetchError) return fail(500, fetchError.message)
  if (!row) return fail(404, 'Not found')
  const reason = auditReason(rawReason)
  if (!reason) return fail(400, 'A reason is required to delete a recorded commitment.')

  if (row.transfer_id) {
    const { error } = await db.from('commitment_events').delete().eq('fund_id', fundId).eq('transfer_id', row.transfer_id)
    if (error) return fail(500, error.message)
  } else {
    const { error } = await db.from('commitment_events').delete().eq('id', id).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    if (error) return fail(500, error.message)
  }
  // The deleted event, whole, is the record that it ever existed.
  await recordAudit(admin, {
    fundId, vehicleId, actorId: ctx.userId, action: 'commitment.delete', subjectType: 'commitment_event', subjectId: String(id), reason,
    details: { deleted: { effectiveDate: row.effective_date, amount: Number(row.amount), memo: row.memo ?? null, kind: row.kind, lpEntityId: row.lp_entity_id, transferId: row.transfer_id ?? null } },
  })
  return done({ ok: true, legs: row.transfer_id ? 2 : 1 })
}
