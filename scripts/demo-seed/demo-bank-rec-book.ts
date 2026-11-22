/**
 * Book Fund II's open bank lines in the demo fund, so its reconciliation ties as Fund I's does.
 * Run after demo-seed-bank-rec-2026.sql.
 *
 *   npx tsx --env-file=.env.local scripts/demo-seed/demo-bank-rec-book.ts
 *
 * Fund II's feed had five lines left from demo-seed-2026: three with draft entries (Q2 management
 * fee, 2025 audit, Q3 administration) and two with none (money market interest, a wire fee). The
 * two get draft entries to the accounts the import suggested; then all five are posted through
 * postBankTransaction, the bank page's Post, so the balance check, the closed-period refusal and
 * the partner allocation run exactly as they do in the app.
 *
 * Idempotent: a line already reconciled is skipped. Not reversed by a -remove file: posted entries
 * are undone in the app (void), as any posted entry is.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { postBankTransaction } from '@/lib/accounting/bank-actions'

const FUND = 'e2dfd2bf-ced3-4647-8277-096e616a6eab'
const GROUP = 'Fund II'
const VEHICLE = 'd73f3df5-5a2f-4c34-b431-e6c8d71fd4e9'
const AGENT_EMAIL = process.env.DEMO_AGENT_EMAIL ?? 'demo-agent@hemrock.invalid'

async function main() {
  const admin = createAdminClient() as any
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const userId = users.users.find((u: { email?: string }) => u.email === AGENT_EMAIL)?.id
  if (!userId) throw new Error(`No ${AGENT_EMAIL}; run scripts/demo-agent-account.ts first.`)

  const { data: accounts } = await admin.from('chart_of_accounts').select('id, code').eq('fund_id', FUND).eq('portfolio_group', GROUP)
  const accountId = (code: string) => {
    const id = (accounts ?? []).find((a: { code: string }) => a.code === code)?.id
    if (!id) throw new Error(`Fund II has no account ${code}`)
    return id as string
  }
  const cash = accountId('1000')

  const { data: open } = await admin.from('bank_transactions')
    .select('id, txn_date, amount, description, status, journal_entry_id, suggested_account_code')
    .eq('fund_id', FUND).eq('portfolio_group', GROUP).in('status', ['unmatched', 'drafted'])

  for (const t of open ?? []) {
    if (!t.journal_entry_id) {
      const contra = accountId(t.suggested_account_code)
      const amount = Number(t.amount)
      // The id is made here rather than read back, so nothing reads journal_entries without a book.
      const entry = { id: crypto.randomUUID() }
      const { error } = await admin.from('journal_entries').insert({
        id: entry.id, fund_id: FUND, portfolio_group: GROUP, vehicle_id: VEHICLE, entry_date: t.txn_date, memo: t.description,
        source_type: amount > 0 ? 'income' : 'partnership_expense', source_ref: 'demo-bank-rec-2026', status: 'draft', book: 'actual',
      })
      if (error) throw error
      const postings = [
        { account_id: cash, amount },
        { account_id: contra, amount: -amount },
      ].map(p => ({ ...p, fund_id: FUND, portfolio_group: GROUP, vehicle_id: VEHICLE, journal_entry_id: entry.id, lp_entity_id: null, book: 'actual' }))
      const { error: pErr } = await admin.from('journal_postings').insert(postings)
      if (pErr) throw pErr
      const { error: tErr } = await admin.from('bank_transactions').update({ journal_entry_id: entry.id, status: 'drafted' }).eq('id', t.id)
      if (tErr) throw tErr
      console.log(`drafted ${t.description} (${amount}) → ${t.suggested_account_code}`)
    }
    const result = await postBankTransaction(admin, FUND, GROUP, userId, t.id, { investments: false })
    if ('error' in result) throw new Error(`${t.description}: ${result.error}`)
    console.log(`posted  ${t.description}`)
  }
  if (!open?.length) console.log('Nothing open in Fund II.')
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
