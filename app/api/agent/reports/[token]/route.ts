import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { visibleLpEntityIds } from '@/lib/access/lp-scope'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { customPeriod } from '@/lib/accounting/statement-period'
import { generateLpStatementPdf } from '@/lib/accounting/lp-statement-pdf'
import { generateLiveInvestorReportPdf } from '@/lib/lp-report-pdf'
import { verifyReportLink } from '@/lib/agent/report-links'
import { carryRecipientIds, seesIndividualCarry } from '@/lib/access/carry-visibility'
import { listVehicles } from '@/lib/accounting/load'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * GET /api/agent/reports/<token> — the PDF behind a link an assistant handed over
 * (`lp_statement_pdf`, `lp_report_card_pdf`; lib/agent/report-links.ts).
 *
 * The token only says WHO asked for WHAT, and that it was this deployment that issued it. Every
 * check is made again here, live, as if the member were asking now: still a member, agent access
 * still on, the LP capital grant, the vehicle and the LP within their entities. A link outlives
 * none of those. Every refusal is the same 404, so a link reveals nothing about why.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params
  const claims = verifyReportLink(token)
  if (!claims) return notFound()

  const limited = await rateLimit({ key: `agent-report:${claims.userId}`, limit: 30, windowSeconds: 60 })
  if (limited) return limited

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('role')
    .eq('fund_id', claims.fundId)
    .eq('user_id', claims.userId)
    .maybeSingle()
  if (!membership) return notFound()
  if (!(await agentApiEnabled(admin, claims.fundId))) return notFound()

  const access = await loadAccessContext(admin, claims.fundId, claims.userId, (membership as { role: string }).role)
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
    console.error('[agent/reports]', claims.kind, e)
    return notFound()
  }
  if (!result) return notFound()

  return new NextResponse(new Uint8Array(result.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${result.fileName.replace(/"/g, '')}"`,
      // A bearer URL: keep it out of shared caches and out of the Referer of anything it links to.
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

function notFound() {
  return NextResponse.json({ error: 'This link has expired or is not available to you.' }, { status: 404 })
}
