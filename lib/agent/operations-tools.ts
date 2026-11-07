// Handlers for the OPERATIONS tools (operations-tools-manifest.ts). Each reads through the same
// library the web page beside it uses, so an answer in chat and the page agree.
//
// ACCESS. The dispatcher has cleared each tool's own domain before its handler runs, and for the
// two entity tools it has resolved an entity the caller may see. What is left is done here: every
// fund-wide read is cut to the caller's entities, and `whats_due`, whose list straddles four
// domains, keeps only the sources the caller holds.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { hasAccess } from '@/lib/access/effective'
import { canSeeVehicle, visibleCompanyIds } from '@/lib/access/scope'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { loadLpScope, lpVisible, visibleLpItems } from '@/lib/access/lp-scope'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { approveCloses } from '@/lib/accounting/close-approval'
import { loadCloseStatus } from '@/lib/accounting/close-status'
import { complianceCalendar, loadComplianceData } from '@/lib/compliance/calendar'
import { loadQuarterRequestStatus } from '@/lib/requests/quarter-status'
import { listRecentDeliveries, type DeliveryKind } from '@/lib/lp-deliveries'
import { collectReminders } from '@/lib/reminders/collect'
import { loadFundReminderData, loadReminderSettings } from '@/lib/reminders/load'
import type { ReminderSource } from '@/lib/reminders/types'
import { PROFILE_COLUMNS, parseProfilePatch, profileFromRow } from '@/lib/vehicle-profile'
import { BUNDLE_FILES, verifyAuditChain, type AuditEventRow } from '@portfolio/fund-engine'
import { isMissingSchema, loadCloseBundle, verifyStoredBundle } from '@/lib/accounting/close-bundle'
import { fetchAllRows } from '@/lib/accounting/load'
import { linkNote, reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import { siteOrigin } from '@/lib/site-links'

const ISO = /^\d{4}-\d{2}-\d{2}$/

function isoArg(input: any, key: string): string | undefined {
  const v = input?.[key]
  if (v == null || v === '') return undefined
  const s = String(v)
  const d = ISO.test(s) ? new Date(`${s}T00:00:00Z`) : null
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`${key} must be a real date (YYYY-MM-DD)`)
  return s
}

const todayIso = () => new Date().toISOString().slice(0, 10)

/** A close bundle's files are returned inline up to this many characters together. */
const INLINE_BUNDLE_CHARS = 60_000

const MISSING_COLUMNS = /column|schema cache/i
const NOT_MIGRATED = 'Entity profiles are not available yet: the database migration that adds them has not been applied.'

async function entityId(ctx: AgentToolContext): Promise<string> {
  const id = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
  if (!id) throw new Error(`Unknown entity "${ctx.portfolioGroup}"`)
  return id
}

/** Which access a reminder source needs, beyond the tool's own `compliance` read. */
const SOURCE_ACCESS: Record<ReminderSource, (ctx: AgentToolContext) => boolean> = {
  compliance: ctx => hasAccess(ctx.access, 'compliance', 'read'),
  asks_send: ctx => hasAccess(ctx.access, 'portfolio', 'read', 'asks'),
  asks_followup: ctx => hasAccess(ctx.access, 'portfolio', 'read', 'asks'),
  calls_due: ctx => hasAccess(ctx.access, 'lp_capital', 'read'),
  onboarding: ctx => hasAccess(ctx.access, 'lp_relations', 'read', 'lp_portal'),
}

export const OPERATIONS_HANDLERS: Record<string, AgentToolHandler> = {
  entity_profile: async ctx => {
    const id = await entityId(ctx)
    const { data, error } = await (ctx.admin as any).from('fund_vehicles').select(PROFILE_COLUMNS).eq('fund_id', ctx.fundId).eq('id', id).maybeSingle()
    if (error) throw new Error(MISSING_COLUMNS.test(error.message ?? '') ? NOT_MIGRATED : error.message)
    return { vehicle: ctx.portfolioGroup, ...profileFromRow(data) }
  },

  set_entity_profile: async (ctx, input) => {
    const { vehicle: _vehicle, ...fields } = (input ?? {}) as Record<string, unknown>
    const parsed = parseProfilePatch(fields)
    if ('error' in parsed) throw new Error(parsed.error)
    if (Object.keys(parsed.update).length === 0) throw new Error('Nothing to change: send at least one profile field.')
    const id = await entityId(ctx)
    const { data, error } = await (ctx.admin as any).from('fund_vehicles').update(parsed.update)
      .eq('fund_id', ctx.fundId).eq('id', id).select(PROFILE_COLUMNS).maybeSingle()
    if (error) throw new Error(MISSING_COLUMNS.test(error.message ?? '') ? NOT_MIGRATED : error.message)
    return { vehicle: ctx.portfolioGroup, ...profileFromRow(data) }
  },

  approve_close: async (ctx, input) => {
    if (!ctx.userId) throw new Error('Approving a close needs a person: this credential has no member behind it.')
    const through = isoArg(input, 'through')
    if (!through) throw new Error('through (the date to approve through) is required')
    const attestation = typeof input?.attestation === 'string' ? input.attestation : null
    const result = await approveCloses(ctx.admin, ctx.fundId, ctx.portfolioGroup, ctx.userId, { through }, attestation)
    if ('error' in result) throw new Error(result.error)
    return { vehicle: ctx.portfolioGroup, ...result }
  },

  close_bundle: async (ctx, input) => {
    if (!hasAccess(ctx.access, 'lp_capital', 'read') || !hasAccess(ctx.access, 'gp_economics', 'read')) {
      throw new Error("A close bundle holds every partner's capital and the carry, so it needs LP capital and GP economics access.")
    }
    const periodEnd = isoArg(input, 'period_end')
    const bundle = await loadCloseBundle(ctx.admin, ctx.fundId, await entityId(ctx), { periodEnd })
    if (!bundle) {
      return { vehicle: ctx.portfolioGroup, bundle: null, note: `No close bundle is recorded for ${ctx.portfolioGroup}${periodEnd ? ` for the period ending ${periodEnd}` : ''}. Bundles are kept for closes made since the feature shipped; reopening and re-closing a period makes one.` }
    }
    const verification = verifyStoredBundle(bundle)
    const size = Object.values(bundle.files).reduce((n, f) => n + f.length, 0)
    const inline = input?.include_files === true || size <= INLINE_BUNDLE_CHARS
    let download: { url: string; expires_at: string; note: string } | null = null
    if (ctx.userId) {
      const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId: ctx.userId, kind: 'close_bundle', args: { vehicle: ctx.portfolioGroup, period: bundle.fiscalPeriodId } })
      download = { url: reportLinkUrl(ctx.origin ?? siteOrigin(), token), expires_at: expiresAt, note: linkNote('A ZIP of the bundle directory. The link works for an hour, and only for this member.') }
    }
    return {
      vehicle: ctx.portfolioGroup,
      period_start: bundle.periodStart,
      period_end: bundle.periodEnd,
      bundle_sha256: bundle.sha256,
      current: bundle.current,
      created_at: bundle.createdAt,
      manifest: bundle.manifest,
      verification: { ok: verification.ok, checks: verification.checks },
      verify_command: `fund-engine verify --bundle <unzipped directory> --expect-sha256 ${bundle.sha256}`,
      download,
      ...(inline
        ? { files: bundle.files }
        : { files: null, files_note: `The files are ${size} characters together; use the download link, or call again with include_files: true. ${BUNDLE_FILES.manifest} is in "manifest".` }),
    }
  },

  verify_audit_trail: async (ctx, input) => {
    const pinnedSeq = input?.pinned_seq == null ? null : Number(input.pinned_seq)
    const pinnedHash = typeof input?.pinned_hash === 'string' ? input.pinned_hash.trim().toLowerCase() : null
    if ((pinnedSeq == null) !== (pinnedHash == null)) throw new Error('Send pinned_seq and pinned_hash together.')
    if (pinnedSeq != null && (!Number.isInteger(pinnedSeq) || pinnedSeq < 1)) throw new Error('pinned_seq must be a positive whole number')

    // 1. The database walks its own chain.
    const { data, error } = await (ctx.admin as any).rpc('verify_accounting_audit_chain', { p_fund_id: ctx.fundId })
    if (error) {
      if (isMissingSchema(error) || /verify_accounting_audit_chain/.test(error.message ?? '')) {
        return { chained: false, note: 'The audit trail is not hash-chained yet: the migration that adds the chain has not been applied.' }
      }
      throw new Error(error.message)
    }
    const db = (Array.isArray(data) ? data[0] : data) ?? {}

    // 2. The same chain recomputed here, by the open fund engine, from the rows as read — so the
    //    answer does not rest on the database that wrote them.
    const rows = await fetchAllRows<AuditEventRow>((f, t) => (ctx.admin as any).from('accounting_audit_events')
      .select('id, fund_id, vehicle_id, actor_id, action, subject_type, subject_id, reason, details, source, created_at, chain_seq, prev_hash, row_hash')
      .eq('fund_id', ctx.fundId).order('chain_seq', { ascending: true }).range(f, t))
    const independent = verifyAuditChain(rows, pinnedSeq != null ? { seq: pinnedSeq, hash: pinnedHash! } : null)

    const dbBreak = db.ok ? null : { seq: db.break_seq == null ? null : Number(db.break_seq), id: db.break_id, problem: db.problem }
    return {
      chained: true,
      ok: !!db.ok && independent.ok,
      events_checked: Number(db.checked ?? 0),
      head: db.head_seq == null ? null : { seq: Number(db.head_seq), hash: db.head_hash },
      first_break: dbBreak ?? independent.firstBreak,
      database: { ok: !!db.ok, first_break: dbBreak },
      independent: { ok: independent.ok, checked: independent.checked, first_break: independent.firstBreak },
      // reached: true = the trail still holds that head; false = it does not; null = an earlier
      // break means the question cannot be answered.
      ...(pinnedSeq != null ? {
        pinned: {
          seq: pinnedSeq, hash: pinnedHash,
          reached: independent.ok ? true : /pinned head/.test(independent.firstBreak?.problem ?? '') ? false : null,
        },
      } : {}),
      note: 'A chain shows rows changed, removed or reordered anywhere before its head. Rows cut off the end only show against a pinned head, such as the one in a close bundle manifest.',
    }
  },

  close_status: async (ctx, input) => {
    const result = await loadCloseStatus(ctx.admin, ctx.fundId, {
      includeManco: hasAccess(ctx.access, 'management_company', 'read'),
      visible: id => canSeeVehicle(ctx.access, id),
      quarterEnd: isoArg(input, 'quarter_end'),
      vehicle: typeof input?.vehicle === 'string' ? input.vehicle : undefined,
    })
    if ('error' in result) throw new Error(result.error)
    return result
  },

  data_request_status: async (ctx, input) => {
    const hasYear = input?.year != null
    const hasQuarter = input?.quarter != null
    if (hasYear !== hasQuarter) throw new Error('Send year and quarter together, or neither for the last quarter that has ended.')
    let period: { year: number; quarter: number } | null = null
    if (hasYear) {
      const year = Number(input.year)
      const quarter = Number(input.quarter)
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('year must be a four-digit year')
      if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new Error('quarter must be 1 to 4')
      period = { year, quarter }
    }
    const companies = await visibleCompanyIds(ctx.admin, ctx.access)
    return loadQuarterRequestStatus(ctx.admin, ctx.fundId, companies, period, todayIso())
  },

  compliance_calendar: async (ctx, input) => {
    const today = todayIso()
    const year = input?.year != null ? Number(input.year) : Number(today.slice(0, 4))
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('year must be a four-digit year')
    const from = isoArg(input, 'from')
    const to = isoArg(input, 'to')
    const data = await loadComplianceData(ctx.admin, ctx.fundId, year, year)
    // The compliance page's rule: firm-level filings for everyone who reads compliance, an
    // entity's own filings only where the caller may see that entity.
    const { vehicleNames } = await entityScopeFor(ctx.admin, ctx.access)
    const wanted = typeof input?.vehicle === 'string' && input.vehicle.trim() ? input.vehicle.trim().toLowerCase() : null
    const rows = complianceCalendar(data, year, today).filter(r =>
      (!r.entity || vehicleNames === null || vehicleNames.includes(r.entity))
      && (!wanted || r.entity.toLowerCase() === wanted)
      && (!from || r.dueDate >= from) && (!to || r.dueDate <= to))
    const counts = { open: 0, overdue: 0, filed: 0, not_applicable: 0 }
    for (const r of rows) counts[r.state] += 1
    return { year, counts, filings: rows }
  },

  lp_delivery_log: async (ctx, input) => {
    const since = isoArg(input, 'since') ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
    const limit = Math.min(Math.max(1, Math.floor(Number(input?.limit ?? 100)) || 100), 500)
    const kind = typeof input?.kind === 'string' && input.kind ? (input.kind as DeliveryKind) : undefined
    const lp = await loadLpScope(ctx.admin, { fundId: ctx.fundId, userId: ctx.access.userId, role: ctx.access.role })
    const page = await listRecentDeliveries(ctx.admin, ctx.fundId, { since, kind, limit })
    let rows = page.filter(d => lpVisible(lp.investorIds, d.lpInvestorId))
    // A document or letter delivery only where the caller can see that item, as /api/lps/deliveries.
    const docs = rows.filter(d => d.kind === 'document' && d.itemId).map(d => d.itemId!)
    const letters = rows.filter(d => d.kind === 'letter' && d.itemId).map(d => d.itemId!)
    const items = await visibleLpItems(ctx.admin, ctx.fundId, lp, { documents: docs, letters })
    if (items) {
      rows = rows.filter(d =>
        d.kind === 'document' ? !!d.itemId && items.documents.has(d.itemId)
          : d.kind === 'letter' ? !!d.itemId && items.letters.has(d.itemId)
            : true)
    }
    const investorIds = Array.from(new Set(rows.map(d => d.lpInvestorId).filter(Boolean))) as string[]
    const names = new Map<string, string>()
    if (investorIds.length) {
      const { data } = await (ctx.admin as any).from('lp_investors').select('id, name').eq('fund_id', ctx.fundId).in('id', investorIds)
      for (const r of (data as any[]) ?? []) names.set(r.id, r.name)
    }
    return {
      since,
      deliveries: rows.map(d => ({
        kind: d.kind, investor: d.lpInvestorId ? names.get(d.lpInvestorId) ?? null : null, to: d.toEmail,
        subject: d.subject, status: d.status, error: d.error, sentAt: d.sentAt,
      })),
      // The newest `limit` sends, before scoping: a full page means older ones may exist.
      hasMore: page.length === limit,
    }
  },

  whats_due: async ctx => {
    // The digest is built fund-wide and its lines do not all name an entity, so it cannot be cut
    // to some of them. A member limited to certain entities gets the per-area tools instead.
    if (!ctx.access.vehicles.all) {
      throw new Error('whats_due covers every entity, and you have access to some of them only. Use close_status, compliance_calendar and data_request_status, which are cut to your entities.')
    }
    const today = todayIso()
    const settings = await loadReminderSettings(ctx.admin, ctx.fundId)
    const data = await loadFundReminderData(ctx.admin, ctx.fundId, today, settings.asksSendOffsetDays)
    const items = collectReminders(data, today).filter(i => SOURCE_ACCESS[i.source](ctx))
    return {
      today,
      items: items.map(i => ({ source: i.source, title: i.title, detail: i.detail ?? null, dueDate: i.dueDate, state: i.state, link: i.href })),
    }
  },
}
