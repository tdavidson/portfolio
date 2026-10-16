// Make someone the admin of a fund that has none — the first step after splitting a fund with
// scripts/split-group-into-fund.sql, which leaves the new fund with no members.
//
//   npx tsx --env-file=.env.local scripts/add-fund-admin.ts --email finance@3seholdings.com --fund "3SE Holdings"
//
// Creates (or reuses) the account, lets it past the signup allow-list, and adds it to the fund as
// admin. The account is confirmed with no password: they sign in with a magic link. Refuses an
// account that already belongs to a fund (one fund per person) or is an investor portal login.
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.

import { createAdminClient } from '../lib/supabase/admin'
import { fundCreationRefusal } from '../lib/onboarding/create-fund'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function main() {
  const email = arg('email')?.trim().toLowerCase()
  const fundArg = arg('fund')?.trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Pass --email person@firm.com')
  if (!fundArg) fail('Pass --fund "<fund name or id>"')
  const admin = createAdminClient()
  const db = admin as any

  // 1. The fund, by id or by exact name.
  const byId = /^[0-9a-f-]{36}$/i.test(fundArg)
  const { data: funds, error: fundError } = await db.from('funds').select('id, name').eq(byId ? 'id' : 'name', fundArg)
  if (fundError) fail(`Could not look up the fund: ${fundError.message}`)
  if (!funds?.length) fail(`No fund ${byId ? 'with id' : 'called'} ${fundArg}`)
  if (funds.length > 1) fail(`More than one fund is called ${fundArg}; pass its id instead.`)
  const fund = funds[0] as { id: string; name: string }

  // 2. Past the signup gate, so the address can exist and sign in.
  const { error: allowError } = await db.from('allowed_signups').insert({ email_pattern: email })
  if (allowError && allowError.code !== '23505') fail(`Could not add ${email} to the signup allow-list: ${allowError.message}`)

  // 3. The account.
  let userId: string | undefined
  for (let page = 1; page <= 20 && !userId; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) fail(`Could not list users: ${error.message}`)
    userId = data.users.find(u => u.email?.toLowerCase() === email)?.id
    if (data.users.length < 1000) break
  }
  if (userId) {
    const { data: membership } = await db.from('fund_members').select('fund_id, role').eq('user_id', userId).maybeSingle()
    if (membership?.fund_id === fund.id) {
      if (membership.role !== 'admin') {
        const { error } = await db.from('fund_members').update({ role: 'admin' }).eq('fund_id', fund.id).eq('user_id', userId)
        if (error) fail(`Could not make ${email} an admin: ${error.message}`)
      }
      console.log(`${email} is an admin of ${fund.name}.`)
      return
    }
    // Same rule as creating a fund: not if they belong to another, not if they are an LP login.
    const refusal = await fundCreationRefusal(admin, userId)
    if (refusal) fail(`${email}: ${refusal}`)
    console.log(`Using the existing account ${email}.`)
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true })
    if (error || !data.user) fail(`Could not create the account: ${error?.message}`)
    userId = data.user.id
    console.log(`Created the account ${email}.`)
  }

  // 4. The membership.
  const { error } = await db.from('fund_members').insert({ fund_id: fund.id, user_id: userId, invited_by: userId, role: 'admin' })
  if (error) fail(`Could not add ${email} to ${fund.name}: ${error.message}`)
  console.log(`${email} is now the admin of ${fund.name}. They sign in with a magic link.`)
}

main().catch(err => fail(err instanceof Error ? err.message : String(err)))
