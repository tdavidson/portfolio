import { recordAudit } from '@/lib/audit/events'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts) — publishing is what goes OUT to an LP. The
// middleware has already checked the caller's grant for this route + method.
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { generateLpStatementPdf } from '@/lib/accounting/lp-statement-pdf'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import { lpCapitalSummary } from '@/lib/accounting/capital-calls'
import { runPool } from '@/lib/lp-report-pdf'

export const runtime = 'nodejs'
// Each statement launches headless Chrome; a vehicle with twenty LPs needs room.
export const maxDuration = 300

// POST — generate a capital account statement PDF per partner, store it in the
// `lp-documents` bucket, and share it with that partner's LP investor so it appears
// in their portal.
//
//   { group?, preset? | start?, end?, lpEntityIds?: string[] }
//
// The PDF is STORED, not re-rendered on demand: a capital statement is a
// point-in-time record, and re-rendering it from the ledger would silently change a
// statement an LP already has if a period were later reopened or an entry amended.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const preset = body?.preset as PeriodPreset | undefined
  const period = preset && preset !== 'custom'
    ? resolvePeriod(preset)
    : customPeriod(body?.start ?? null, body?.end ?? null)

  // REFUSE TO PUBLISH AN UNCLOSED PERIOD.
  //
  // P&L only reaches capital accounts at the close. Publish a month that hasn't been closed
  // and every statement goes out with zeroed management-fee, expense and gain lines — quietly
  // wrong, and worse, PERMANENTLY so: these PDFs are stored rather than re-rendered (that is
  // the whole point of them), so an LP files a document that can never be corrected in place.
  //
  // `force: true` is the escape hatch for a deliberate interim statement, but it has to be
  // asked for — and it is recorded in the audit trail, with who asked.
  //
  // THIS entity's period, and an APPROVED one. The lookup used to match any vehicle's closed
  // period in the fund (no vehicle filter), and a close nobody had signed off is not one to send
  // to partners: the close is prepared by one member and approved by another (close-approval.ts).
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (period.end && !body?.force) {
    const { data: coveringRows } = await admin
      .from('fiscal_periods' as any)
      .select('id, status, close_reviews(status)')
      .eq('fund_id', gate.fundId)
      .eq('vehicle_id', vehicleId)
      .eq('status', 'closed')
      .lte('period_start', period.end)
      .gte('period_end', period.end)
      .limit(1)
    const covering = ((coveringRows as any[]) ?? [])[0]

    if (!covering) {
      return NextResponse.json({
        error:
          `The period ending ${period.end} is not closed, so no fees, expenses or gains have reached the partners' capital accounts yet — ` +
          `every statement would show them as zero. Close the period first, or re-send with { "force": true } if you really want an interim statement.`,
      }, { status: 400 })
    }
    const reviews = [covering.close_reviews ?? []].flat() as { status: string }[]
    if (reviews.some(r => r.status === 'prepared')) {
      return NextResponse.json({
        error: `The close through ${period.end} has not been approved yet. A second member approves it on the Periods page; then publish.`,
      }, { status: 400 })
    }
  }
  if (body?.force) {
    await recordAudit(admin, {
      fundId: gate.fundId, vehicleId, actorId: user.id, action: 'lp_statement.force_publish', subjectType: 'lp_statement',
      reason: 'Interim statement published before the period was closed and approved (force).',
      details: { start: period.start ?? null, end: period.end ?? null, lpEntityIds: body?.lpEntityIds ?? 'all' },
    })
  }

  // Default to every partner in the vehicle.
  const summary = await lpCapitalSummary(admin, gate.fundId, group)
  const requested: string[] = Array.isArray(body?.lpEntityIds) ? body.lpEntityIds : []
  const targets = requested.length > 0
    ? summary.filter(r => requested.includes(r.lpEntityId))
    : summary
  if (targets.length === 0) return NextResponse.json({ error: 'No partners in this vehicle' }, { status: 400 })

  // lpStatement is keyed by lp_entity_id; every share table is keyed by
  // lp_investor_id. lp_entities.investor_id is the hop between them.
  const { data: entityRows } = await admin
    .from('lp_entities' as any)
    .select('id, investor_id')
    .eq('fund_id', gate.fundId)
    .in('id', targets.map(t => t.lpEntityId))
  const investorByEntity = new Map<string, string | null>(
    ((entityRows as any[]) ?? []).map(e => [e.id as string, (e.investor_id ?? null) as string | null])
  )

  const published: { lpEntityId: string; name: string; documentId: string; shared: boolean }[] = []
  const errors: string[] = []

  await runPool(targets, 3, async target => {
    try {
      const result = await generateLpStatementPdf(admin, {
        fundId: gate.fundId, group, lpEntityId: target.lpEntityId, period,
      })
      if (!result) { errors.push(`${target.name}: could not build the statement`); return }

      const safeName = result.fileName.replace(/[^a-zA-Z0-9 ._-]/g, '_')
      const storagePath = `${gate.fundId}/${Date.now()}_${safeName}`

      // The Buffer is already here on the server, so upload it directly rather than
      // round-tripping through a signed upload URL (which exists for browser uploads).
      const { error: upErr } = await admin.storage
        .from('lp-documents')
        .upload(storagePath, result.pdf, { contentType: 'application/pdf', upsert: false })
      if (upErr) { errors.push(`${target.name}: upload failed — ${upErr.message}`); return }

      const investorId = investorByEntity.get(target.lpEntityId) ?? null

      const { data: doc, error: docErr } = await admin
        .from('lp_documents' as any)
        .insert({
          fund_id: gate.fundId,
          title: `Capital Account Statement — ${period.label}`,
          file_name: result.fileName,
          storage_path: storagePath,
          mime_type: 'application/pdf',
          size_bytes: result.pdf.length,
          // Investor-scoped: a capital statement is for exactly one partner.
          scope: 'investor',
          vehicle: group,
          category: 'Capital Account Statement',
          doc_date: period.end,
          uploaded_by: user.id,
        })
        .select('id')
        .single()
      if (docErr || !doc) { errors.push(`${target.name}: ${docErr?.message ?? 'insert failed'}`); return }

      if (investorId) {
        await admin.from('lp_document_shares' as any).insert({
          document_id: (doc as any).id,
          lp_investor_id: investorId,
          fund_id: gate.fundId,
        })
      } else {
        // Generated and stored, but nobody can see it until the entity is linked to
        // an LP investor. Say so rather than reporting a silent success.
        errors.push(`${target.name}: generated, but not shared — this entity has no LP investor to share with.`)
      }

      published.push({
        lpEntityId: target.lpEntityId,
        name: target.name,
        documentId: (doc as any).id,
        shared: !!investorId,
      })
    } catch (e) {
      errors.push(`${target.name}: ${(e as Error).message}`)
    }
  })

  return NextResponse.json({ period, published, errors, count: published.length })
}
