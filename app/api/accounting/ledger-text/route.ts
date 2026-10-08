import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { exportLedgerText, postLedgerText } from '@/lib/accounting/text-ledger-run'

// GET — the vehicle's ledger serialized to plain-text double-entry.
//   ?asOf=YYYY-MM-DD   only entries on or before that date
//   ?download=1        as a text file rather than JSON
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group

  const asOf = sp.get('asOf')
  let text: string
  try {
    text = await exportLedgerText(admin, gate.fundId, group, asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : undefined)
  } catch (e) {
    // An export missing its adopted: refs would be re-adopted on import — refuse rather than write it.
    console.error('[ledger-text-export]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'The ledger could not be exported because part of it could not be read. Try again.' }, { status: 500 })
  }
  if (sp.get('download')) {
    const filename = `ledger-${group}${asOf ? `-${asOf}` : ''}`.replace(/[^a-zA-Z0-9\-]/g, '-')
    return new NextResponse(text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.txt"`,
      },
    })
  }
  return NextResponse.json({ text })
}

// POST — parse authored text and persist each balanced entry.
// Body: { text, status?: 'draft'|'posted', group? }
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

  const text: string = (body?.text ?? '').toString()
  if (text.trim().length < 10) return NextResponse.json({ error: 'Nothing to post' }, { status: 400 })
  const status = body?.status === 'draft' ? 'draft' : body?.status === 'posted' ? 'posted' : undefined

  const access = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  const result = await postLedgerText(admin, gate.fundId, group, user.id, text, status, body?.reviewToken, hasAccess(access, 'lp_capital', 'read'))
  return NextResponse.json(result)
}
