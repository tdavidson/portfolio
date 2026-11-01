import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadGateAccess } from '@/lib/access/request-context'
import { outcomeResponse } from '@/lib/service-outcome'
import { areaLabel, fileRecord, listRecords, readRecord, readableAreas } from '@/lib/records'

/**
 * Fund records: what a person or their assistant filed from a working session (lib/records).
 *
 *   GET  ?area=&entity=&subject_type=&subject_id=&q=&limit=   → records you may see, without bodies
 *   GET  ?id=                                                 → one record, with its body
 *   POST { area, entity?, kind?, title, body, subject_type?, subject_id? }
 *
 * Gated at 'any' in route-domains.ts because a record's domain is its AREA, which the request
 * names: lib/records/areas.ts checks read on it here, as the file_to_record, list_records and
 * read_record tools do. Filing needs read, not write; it adds the fund's note and changes nothing.
 */

async function ctx() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return { error: gate }
  const access = await loadGateAccess(admin, gate)
  return { admin, actor: { access, userId: user.id, email: user.email ?? null } }
}

export async function GET(req: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  const p = req.nextUrl.searchParams
  const id = p.get('id')
  if (id) return outcomeResponse(await readRecord(c.admin, c.actor, id), record => ({ record }))
  return outcomeResponse(
    await listRecords(c.admin, c.actor, {
      area: p.get('area') || undefined, entity: p.get('entity') || undefined,
      subjectType: p.get('subject_type') || undefined, subjectId: p.get('subject_id') || undefined,
      query: p.get('q') || undefined, limit: p.get('limit') || undefined,
    }),
    records => ({
      records,
      areas: readableAreas(c.actor.access).map(id => ({ id, label: areaLabel(id) })),
      entityScoped: !c.actor.access.vehicles.all,
      canFile: c.actor.access.role !== 'viewer',
    }),
  )
}

export async function POST(req: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await fileRecord(c.admin, c.actor, body), record => ({ record }))
}
