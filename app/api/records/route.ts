import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadGateAccess } from '@/lib/access/request-context'
import { outcomeResponse } from '@/lib/service-outcome'
import { areaLabel, canFileRecords, fileRecord, listRecords, readRecord, readableAreas } from '@/lib/records'

/**
 * Fund records: what a person or their assistant filed from a working session (lib/records).
 *
 *   GET  ?area=&entity=&subject_type=&subject_id=&q=&limit=   → records you may see, without bodies
 *   GET  ?id=                                                 → one record, with its body
 *   POST { area, entity?, kind?, title, body, subject_type?, subject_id? }
 *
 * Gated on the Records access right in route-domains.ts: read to list or open, write to file. The
 * record's AREA, which the request names, is then checked here by lib/records/areas.ts (read on it,
 * for filing too), as the file_to_record, list_records and read_record tools do.
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
      canFile: canFileRecords(c.actor.access),
    }),
  )
}

export async function POST(req: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await fileRecord(c.admin, c.actor, body), record => ({ record }))
}
