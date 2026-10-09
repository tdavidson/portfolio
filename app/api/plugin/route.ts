import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { issuerFor } from '@/lib/oauth/metadata'
import { APP_VERSION } from '@/lib/version'
import { isPluginTarget, pluginFilename, pluginZip } from '@/lib/plugin/build'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/plugin?target=claude|chatgpt
//
// The plugin for THIS deployment, as a zip: the skills, and a connector whose address is this
// deployment's own MCP endpoint. Why the app builds it per deployment is in lib/plugin/build.ts.
//
// The package is the same for every member and holds no credential and no fund data beyond the
// fund's name in its label. It is still members-only: there is no reason to tell the internet
// which fund runs at this address, and a member is the only person it is any use to.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const fundId = (membership as { fund_id: string } | null)?.fund_id
  if (!fundId) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const target = req.nextUrl.searchParams.get('target')
  if (!isPluginTarget(target)) {
    return NextResponse.json({ error: 'target must be "claude" or "chatgpt"' }, { status: 400 })
  }

  // The connector answers nothing while the fund's switch is off. Handing out a package that
  // installs cleanly and then fails on first use helps nobody.
  if (!(await agentApiEnabled(admin, fundId))) {
    return NextResponse.json(
      { error: 'Agent access is disabled for this fund. An admin can enable it in Settings → Agent access.' },
      { status: 403 }
    )
  }

  const { data: fund } = await admin.from('funds').select('name').eq('id', fundId).maybeSingle()
  // The same origin the OAuth discovery documents use (lib/oauth/metadata.ts): whatever domain
  // the member reached us on is the one their assistant must be sent back to.
  const context = {
    origin: issuerFor(req),
    fundName: (fund as { name?: string } | null)?.name ?? null,
    version: APP_VERSION,
  }

  const zip = await pluginZip(target, context)
  return new NextResponse(Buffer.from(zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${pluginFilename(target, context)}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
