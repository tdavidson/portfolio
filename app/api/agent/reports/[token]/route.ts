import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { hasAccess, loadAccessContext, type AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { visibleLpEntityIds } from '@/lib/access/lp-scope'
import { resolveVehicle, VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'
import { customPeriod } from '@/lib/accounting/statement-period'
import { generateLpStatementPdf } from '@/lib/accounting/lp-statement-pdf'
import { generateInvestorReportPdf, generateLetterPdf, generateLiveInvestorReportPdf } from '@/lib/lp-report-pdf'
import { isExpiredReportLink, verifyReportLink, type ReportLinkClaims } from '@/lib/agent/report-links'
import { SEND_ATTACHMENT_PURPOSE } from '@/lib/agent/remote-pdf'
import { PERFORMANCE_GROUPINGS, type PerformanceGrouping } from '@/lib/accounting/fund-performance'
import {
  DocumentBuildError, financialStatementsDocument, fundPerformanceDocument, k1Document, taxPackageDocument, type FundDocument,
} from '@/lib/reports/documents'
import { carryRecipientIds, seesIndividualCarry } from '@/lib/access/carry-visibility'
import { listVehicles } from '@/lib/accounting/load'
import { rateLimit } from '@/lib/rate-limit'
import { withChangeSource } from '@/lib/audit/source'
import { logLpAccessEvent } from '@/lib/lp-access-log'
import { connectorPrincipal, lpConnectorEnabled } from '@/lib/portal/principal'
import { PortalError, portalLetterShare, portalStatementInvestors } from '@/lib/portal/service'
import { getLetter } from '@/lib/lp-letters/service'
import { renderPdf as renderTemplateDocumentPdf } from '@/lib/document-templates/pdf'
import { callNoticePreviewPdf } from '@/lib/accounting/notice-preview'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * GET /api/agent/reports/<token> — the document behind a link an assistant handed over
 * (`lp_statement_pdf`, `lp_report_card_pdf`, the `*_pdf` document tools; lib/agent/report-links.ts).
 *
 * The token only says WHO asked for WHAT, and that it was this deployment that issued it. Every
 * check is made again here, live, as if the member were asking now: still a member, agent access
 * still on, the LP capital grant, the vehicle and the LP within their entities. A link outlives
 * none of those. Every refusal is the same 404, so a link reveals nothing about why. The one exception
 * is expiry (410), which the token already states to anyone who reads it.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params
  const claims = verifyReportLink(token)
  if (!claims) return isExpiredReportLink(token) ? expired() : notFound()

  // A link minted for an email attachment (lib/agent/remote-pdf.ts) is fetched once per recipient by
  // this deployment, not clicked by a person: a send to forty LPs is forty renders in a minute. Its
  // own bucket, so a send neither trips the click limit nor spends it. The purpose is in the signed
  // claims, so only this deployment can mint one.
  const forSend = claims.args.for === SEND_ATTACHMENT_PURPOSE
  const limited = await rateLimit(forSend
    ? { key: `agent-report-send:${claims.userId}`, limit: 300, windowSeconds: 60 }
    : { key: `agent-report:${claims.userId}`, limit: 30, windowSeconds: 60 })
  if (limited) return limited

  const admin = createAdminClient()
  // The investor connector's link: an LP's own statement. Re-checked as an investor, never as a
  // fund member, and recorded in the LP access log as a download through MCP.
  if (claims.kind === 'portal_statement') return withChangeSource('mcp', () => portalStatement(admin, claims.fundId, claims.userId))
  if (claims.kind === 'portal_letter') return withChangeSource('mcp', () => portalLetterDocument(admin, claims.fundId, claims.userId, String(claims.args.letter ?? '')))

  const { data: membership } = await admin
    .from('fund_members')
    .select('role')
    .eq('fund_id', claims.fundId)
    .eq('user_id', claims.userId)
    .maybeSingle()
  if (!membership) return notFound()
  if (!(await agentApiEnabled(admin, claims.fundId))) return notFound()

  const access = await loadAccessContext(admin, claims.fundId, claims.userId, (membership as { role: string }).role)
  if (claims.kind !== 'lp_statement' && claims.kind !== 'lp_report_card') return fundDocument(admin, claims, access)
  if (!hasAccess(access, 'lp_capital', 'read')) return notFound()
  const scope = await entityScopeFor(admin, access)

  let result: { pdf: Buffer; fileName: string } | null = null
  try {
    if (claims.kind === 'lp_statement') {
      const a = claims.args as Record<string, string | null>
      // Throws for a vehicle outside the member's entities.
      const group = await resolveVehicle(admin, claims.fundId, a.vehicle ?? undefined, { access })
      const visible = await visibleLpEntityIds(admin, scope)
      if (!a.lp || (visible !== null && !visible.includes(a.lp))) return notFound()
      // A carry recipient's statement is what they earn: GP economics.
      if (!seesIndividualCarry(access) && (await carryRecipientIds(admin, claims.fundId, group)).has(a.lp)) return notFound()
      // The dates and label as resolved when the link was made, so "last quarter" cannot become a
      // different quarter between the conversation and the click.
      const period = { ...customPeriod(a.start, a.end), ...(a.label ? { label: a.label } : {}) }
      result = await generateLpStatementPdf(admin, { fundId: claims.fundId, group, lpEntityId: a.lp, period })
    } else {
      const investor = claims.args.investor
      if (typeof investor !== 'string') return notFound()
      // A member who sees some entities gets those, never the investor's whole position; and,
      // without gp_economics, none of the positions on which the investor receives carry.
      let omit: Map<string, Set<string>> | undefined
      if (!seesIndividualCarry(access)) {
        // null = every vehicle (not none): the recipients of each one the fund has.
        const groups = scope.vehicleNames === null ? await listVehicles(admin, claims.fundId) : scope.vehicleNames
        omit = new Map(await Promise.all(groups.map(async g => [g, await carryRecipientIds(admin, claims.fundId, g)] as [string, Set<string>])))
      }
      result = await generateLiveInvestorReportPdf(admin, { fundId: claims.fundId, investorIds: [investor], groups: scope.vehicleNames, ...(omit ? { omit } : {}) })
    }
  } catch (e) {
    // NOT notFound(). Every check above has passed by now, so saying so reveals nothing — and
    // answering a render failure with "this link has expired" sent the last one hunting for an
    // expiry problem while Chromium was missing from the function (lib/pdf-routes.mjs).
    // The one throw that IS a refusal: resolveVehicle, for a vehicle outside the member's entities.
    if (e instanceof VehicleResolutionError) return notFound()
    console.error('[agent/reports]', claims.kind, e)
    return NextResponse.json({ error: 'This document could not be generated. Try again, or ask for a new link.' }, { status: 500 })
  }
  if (!result) return notFound()

  return documentResponse({ body: result.pdf, fileName: result.fileName, contentType: 'application/pdf' })
}

/**
 * The fund's own documents (lib/reports/documents.ts). Each is gated here exactly as its web route
 * is gated (lib/access/route-domains.ts, plus the checks that route makes in its handler), so a link
 * can hand over nothing the member could not download from the app right now.
 */
async function fundDocument(admin: ReturnType<typeof createAdminClient>, claims: ReportLinkClaims, access: AccessContext) {
  const { fundId } = claims
  const a = claims.args as Record<string, string | null>
  let doc: FundDocument | null = null
  try {
    switch (claims.kind) {
      // /api/accounting/fund-performance/pdf — accounting.
      case 'fund_performance': {
        if (!hasAccess(access, 'accounting', 'read')) return notFound()
        const grouping = a.group_by as PerformanceGrouping
        if (!a.as_of || !PERFORMANCE_GROUPINGS.includes(grouping)) return notFound()
        const group = await resolveVehicle(admin, fundId, a.vehicle ?? undefined, { access })
        doc = await fundPerformanceDocument(admin, fundId, group, a.as_of, grouping)
        break
      }
      // /api/accounting/statements/pdf — accounting. The dates as resolved when the link was made.
      case 'financial_statements': {
        if (!hasAccess(access, 'accounting', 'read')) return notFound()
        const group = await resolveVehicle(admin, fundId, a.vehicle ?? undefined, { access })
        const sp = new URLSearchParams()
        for (const k of ['start', 'end', 'compare', 'basis'] as const) if (a[k]) sp.set(k, a[k] as string)
        doc = await financialStatementsDocument(admin, fundId, group, sp)
        break
      }
      // /api/accounting/tax-package — accounting; the K-1 workbook only for a caller who may read K-1s.
      case 'tax_package': {
        if (!hasAccess(access, 'accounting', 'read')) return notFound()
        const year = Number(a.year)
        if (!Number.isInteger(year)) return notFound()
        const group = await resolveVehicle(admin, fundId, a.vehicle ?? undefined, { access })
        const includeK1 = hasAccess(access, 'gp_economics', 'read') && hasAccess(access, 'lp_capital', 'read')
        doc = await taxPackageDocument(admin, fundId, group, year, { includeK1 })
        break
      }
      // /api/accounting/k1-packages/pdf — tax (tax_reporting), the carry, and the package's entity.
      case 'k1': {
        if (!hasAccess(access, 'tax', 'read', 'tax_reporting') || !hasAccess(access, 'gp_economics', 'read')) return notFound()
        if (!a.package || !a.lp) return notFound()
        const { data: pkg } = await (admin as any).from('k1_packages').select('vehicle_id').eq('id', a.package).eq('fund_id', fundId).maybeSingle()
        if (!pkg || !canSeeVehicle(access, (pkg as any).vehicle_id ?? null)) return notFound()
        doc = await k1Document(admin, fundId, a.package, a.lp)
        break
      }
      // /api/lps/preview/snapshot/[id]/pdf — lp_capital (lp_portal), and every entity: the report
      // shows the investor everything they hold. `investor` is one investor's (lp_snapshot's link);
      // `investors` is one email recipient's investors together, as the send route renders them
      // (lib/agent/remote-pdf.ts). Every one must be the fund's.
      case 'lp_snapshot': {
        if (!hasAccess(access, 'lp_capital', 'read', 'lp_portal') || !canSeeVehicle(access, null)) return notFound()
        const many = claims.args.investors
        const investorIds = Array.isArray(many) ? Array.from(new Set(many.map(String))) : a.investor ? [a.investor] : []
        if (!a.snapshot || investorIds.length === 0) return notFound()
        const { data: invs } = await (admin as any).from('lp_investors').select('id').eq('fund_id', fundId).in('id', investorIds)
        if (((invs ?? []) as unknown[]).length !== investorIds.length) return notFound()
        const result = await generateInvestorReportPdf(admin, { fundId, snapshotId: a.snapshot, investorIds })
        doc = result ? { body: result.pdf, fileName: result.fileName, contentType: 'application/pdf' } : null
        break
      }
      // An LP letter, as the fund sees it — lp_relations (lp_letters), and the letter's entity.
      case 'lp_letter': {
        if (!hasAccess(access, 'lp_relations', 'read', 'lp_letters')) return notFound()
        const scope = await entityScopeFor(admin, access)
        const letter = await getLetter(admin, fundId, scope.vehicleNames, a.letter ?? '')
        if (!letter.ok || !letter.value || letter.value.status === 'generating') return notFound()
        const result = await generateLetterPdf(admin, { fundId, letterId: letter.value.id })
        doc = result ? { body: result.pdf, fileName: result.fileName, contentType: 'application/pdf' } : null
        break
      }
      // A document filled from one of the fund's own templates (document_generate) — an LP letter, so
      // lp_relations (lp_letters). It prints the render stored when it was generated.
      case 'template_document': {
        if (!hasAccess(access, 'lp_relations', 'read', 'lp_letters')) return notFound()
        if (!a.render) return notFound()
        const result = await renderTemplateDocumentPdf(admin, fundId, a.render)
        doc = result ? { body: result.pdf, fileName: result.fileName, contentType: 'application/pdf' } : null
        break
      }
      // /api/accounting/notices/preview — lp_relations (lp_portal), and the call's entity. One
      // partner's notice for an issued call, marked DRAFT: what preview_call_notices links to.
      case 'call_notice_preview': {
        if (!hasAccess(access, 'lp_relations', 'read', 'lp_portal')) return notFound()
        if (!a.call || !a.lp) return notFound()
        const group = await resolveVehicle(admin, fundId, a.vehicle ?? undefined, { access })
        const out = await callNoticePreviewPdf(admin, { fundId, group }, a.call, a.lp)
        doc = out.ok ? { body: out.value.pdf, fileName: out.value.fileName, contentType: 'application/pdf' } : null
        break
      }
      default:
        return notFound()
    }
  } catch (e) {
    if (e instanceof VehicleResolutionError) return notFound()
    if (e instanceof DocumentBuildError) return NextResponse.json({ error: e.message }, { status: 500 })
    console.error('[agent/reports]', claims.kind, e)
    return NextResponse.json({ error: 'This document could not be generated. Try again, or ask for a new link.' }, { status: 500 })
  }
  if (!doc) return notFound()
  return documentResponse(doc)
}

function documentResponse(doc: FundDocument) {
  return new NextResponse(new Uint8Array(doc.body), {
    headers: {
      'Content-Type': doc.contentType,
      // A PDF opens in the tab; a ZIP can only be saved.
      'Content-Disposition': `${doc.contentType === 'application/pdf' ? 'inline' : 'attachment'}; filename="${doc.fileName.replace(/"/g, '')}"`,
      // A bearer URL: keep it out of shared caches and out of the Referer of anything it links to.
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

async function portalStatement(admin: ReturnType<typeof createAdminClient>, fundId: string, userId: string) {
  if (!(await lpConnectorEnabled(admin, fundId))) return notFound()
  const principal = await connectorPrincipal(admin, userId, fundId)
  if (!principal) return notFound()
  let investorIds: string[]
  try {
    investorIds = await portalStatementInvestors(admin, principal, fundId)
  } catch (e) {
    if (e instanceof PortalError) return notFound()
    throw e
  }
  let result: { pdf: Buffer; fileName: string } | null
  try {
    result = await generateLiveInvestorReportPdf(admin, { fundId, investorIds })
  } catch (e) {
    console.error('[agent/reports] portal_statement', e)
    return NextResponse.json({ error: 'This document could not be generated. Try again, or ask for a new link.' }, { status: 500 })
  }
  if (!result) return notFound()
  await logLpAccessEvent(admin, {
    fundId, lpAccountId: principal.lpAccountId, authUserId: userId, lpInvestorId: investorIds[0] ?? null,
    eventType: 'download', targetType: 'snapshot', targetTitle: result.fileName, metadata: { investor_ids: investorIds, format: 'pdf', live: true },
  })
  return documentResponse({ body: result.pdf, fileName: result.fileName, contentType: 'application/pdf' })
}

/** A letter shared with the investor, checked as the portal's own letter PDF route checks it, at the click. */
async function portalLetterDocument(admin: ReturnType<typeof createAdminClient>, fundId: string, userId: string, letterId: string) {
  if (!(await lpConnectorEnabled(admin, fundId))) return notFound()
  const principal = await connectorPrincipal(admin, userId, fundId)
  if (!principal) return notFound()
  let share: { fundId: string; sharedInvestorIds: string[] }
  try {
    share = await portalLetterShare(admin, principal, letterId)
  } catch (e) {
    if (e instanceof PortalError) return notFound()
    throw e
  }
  // The connection is bound to one fund; a letter from another fund the LP holds is not this link's.
  if (share.fundId !== fundId) return notFound()
  let result: { pdf: Buffer; fileName: string } | null
  try {
    result = await generateLetterPdf(admin, { fundId, letterId })
  } catch (e) {
    console.error('[agent/reports] portal_letter', e)
    return NextResponse.json({ error: 'This document could not be generated. Try again, or ask for a new link.' }, { status: 500 })
  }
  if (!result) return notFound()
  await logLpAccessEvent(admin, {
    fundId, lpAccountId: principal.lpAccountId, authUserId: userId, lpInvestorId: share.sharedInvestorIds[0] ?? null,
    eventType: 'download', targetType: 'letter', targetId: letterId, targetTitle: result.fileName,
    metadata: { investor_ids: share.sharedInvestorIds, format: 'pdf' },
  })
  return documentResponse({ body: result.pdf, fileName: result.fileName, contentType: 'application/pdf' })
}

// Two messages, not one. They used to be the same — "expired or not available" — and a link reused
// after its hour (an assistant re-sharing one from earlier in the conversation) read exactly like a
// broken route.
function expired() {
  return NextResponse.json(
    { error: 'This link has expired — links last an hour. Ask the assistant for the document again to get a new one.' },
    { status: 410 },
  )
}

function notFound() {
  return NextResponse.json({ error: 'This link is not available to you.' }, { status: 404 })
}
