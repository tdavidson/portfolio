// Provision the demo fund's agent account — the login you use to connect claude.ai to the demo.
//
// WHY AN ACCOUNT AND NOT A KEY: claude.ai's connector speaks OAuth (it discovers the server,
// registers itself, and sends you to /oauth/authorize). There is nowhere to paste a static `lk_…`
// key, so the demo needs a real login that can complete the consent screen.
//
// WHY NOT THE DEMO LOGIN: it's a `viewer`, and /oauth/consent refuses viewers outright — the
// read-only demo may not hand an agent the keys to a fund. That refusal is what stops your
// visitors connecting their own Claude to the demo, so it stays.
//
// WHAT MAKES THIS SAFE: the account is a `member` (so consent lets it through) whose GRANTS are
// read-only on every domain. Read-only therefore comes from the grants, not the role — which is
// exactly what the grants are for. Three things follow:
//   * every write is refused per-domain by authorizeToolUse, whatever scope the token carries;
//   * the consent screen says "read" rather than promising writes (canWriteAnywhere is false);
//   * a visitor still can't do any of this — they're the viewer, and consent refuses them.
//
// Run:  npx tsx scripts/demo-agent-account.ts
// Prints the email + password. Sign in as it in a private window, connect claude.ai, done.

import { createAdminClient } from '../lib/supabase/admin'
import { DOMAINS, DOMAIN_META } from '../lib/access/domains'

// Not imported from lib/demo/seed: the demo fixtures are leaving this repo and this script isn't.
const DEMO_FUND_NAME = process.env.DEMO_FUND_NAME ?? 'Hemrock Ventures'
const AGENT_EMAIL = process.env.DEMO_AGENT_EMAIL ?? 'demo-agent@hemrock.invalid'

/** Long and random. Printed once; rerun to roll it. */
function newPassword(): string {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`.replace(/-/g, '').slice(0, 32)
}

async function main() {
  const admin = createAdminClient()

  const { data: fund } = await admin.from('funds').select('id').eq('name', DEMO_FUND_NAME).maybeSingle()
  if (!fund) {
    console.error(`No "${DEMO_FUND_NAME}" fund found. Seed the demo first.`)
    process.exit(1)
  }
  const fundId = (fund as { id: string }).id
  const password = newPassword()

  // 1. The account. Rerunning rolls the password — OAuth tokens survive it, so an existing
  //    claude.ai connection keeps working.
  const { data: existing } = await admin.auth.admin.listUsers()
  let agentUserId = existing?.users?.find(u => u.email === AGENT_EMAIL)?.id

  if (agentUserId) {
    const { error } = await admin.auth.admin.updateUserById(agentUserId, { password })
    if (error) { console.error('Could not reset the agent password:', error.message); process.exit(1) }
    console.log(`Reusing agent account ${AGENT_EMAIL} (password rolled).`)
  } else {
    const { data: created, error } = await admin.auth.admin.createUser({
      email: AGENT_EMAIL,
      password,
      email_confirm: true,
    })
    if (error || !created?.user) { console.error('Could not create the agent account:', error?.message); process.exit(1) }
    agentUserId = created.user.id
    console.log(`Created agent account ${AGENT_EMAIL}`)
  }

  // 2. A MEMBER, not a viewer — consent refuses viewers, and that refusal is what keeps visitors out.
  //    `all_entities`, because a member sees only the entities they're granted, and a new member
  //    is granted none: without it every tool answers from an empty fund (show_home still renders,
  //    since it carries no data). Viewers and admins get every entity by role; members don't.
  const { error: memberError } = await (admin as any)
    .from('fund_members')
    .upsert({ fund_id: fundId, user_id: agentUserId, role: 'member', all_entities: true }, { onConflict: 'fund_id,user_id' })
  if (memberError) { console.error('Could not add the agent to the fund:', memberError.message); process.exit(1) }

  // 3. Read-only everywhere, explicitly. THIS is what makes the account safe — not its role.
  //    `admin` is excluded: it's role-governed and can never be granted.
  const grantable = DOMAINS.filter(d => !DOMAIN_META[d].adminOnly)
  const { error: grantError } = await (admin as any).from('fund_member_access').upsert(
    grantable.map(domain => ({
      fund_id: fundId,
      user_id: agentUserId,
      domain,
      level: 'read',
      updated_at: new Date().toISOString(),
    })),
    { onConflict: 'fund_id,user_id,domain' },
  )
  if (grantError) { console.error('Could not set the read-only grants:', grantError.message); process.exit(1) }

  // 4. The fund's agent surface, or every call 403s.
  const { error: settingsError } = await (admin as any).from('fund_settings').update({ agent_api_enabled: true }).eq('fund_id', fundId)
  if (settingsError) { console.error('Could not turn on Agent access:', settingsError.message); process.exit(1) }

  console.log('\n✅ Demo agent account ready — read-only on all', grantable.length, 'domains, every entity.\n')
  console.log(`   email:    ${AGENT_EMAIL}`)
  console.log(`   password: ${password}\n`)
  console.log('   1. Sign in as it in a private window (it belongs to the demo fund).')
  console.log('   2. In claude.ai, add a custom connector pointing at  <your-url>/api/mcp')
  console.log('   3. Approve the consent screen — it will say READ, because that is all it can do.\n')
  console.log('   Demo visitors cannot do this: they sign in as the viewer, and consent refuses viewers.\n')
  process.exit(0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
