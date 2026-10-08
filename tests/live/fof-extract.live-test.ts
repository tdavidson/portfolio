import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { createFundAIProvider } from '@/lib/ai'
import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { readManagerDocument } from '@/lib/portfolio/fof-extract'
import { matchHoldings } from '@/lib/portfolio/fof-paste'

/**
 * The extraction path against a REAL model, on the fund that actually has an AI key.
 *
 * READ-ONLY. Extraction is a proposal engine — it writes nothing anywhere, by design. The only
 * side effect of this file is tokens on the fund's own key.
 */
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const admin: any = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/** A capital account statement in the shape a manager actually sends one. */
const STATEMENT_HTML = `
<html><body style="font-family:Georgia,serif;padding:40px;">
  <h1 style="font-size:20px;">Meridian Growth Partners IV, L.P.</h1>
  <p style="font-size:12px;color:#555;">Limited Partner Capital Account Statement</p>
  <p style="font-size:12px;">Partner: Laconia Capital Group<br/>
     Period: Three months ended <b>September 30, 2025</b><br/>
     Statement issued: November 14, 2025</p>

  <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:20px;">
    <tr><td style="padding:4px;">Beginning capital account, July 1, 2025</td>
        <td style="padding:4px;text-align:right;">8,420,000</td></tr>
    <tr><td style="padding:4px;">Capital contributions (Drawdown No. 7, funded August 12, 2025)</td>
        <td style="padding:4px;text-align:right;">1,250,000</td></tr>
    <tr><td style="padding:4px;">Distributions</td>
        <td style="padding:4px;text-align:right;">(475,000)</td></tr>
    <tr><td style="padding:4px;">Management fee</td>
        <td style="padding:4px;text-align:right;">(52,500)</td></tr>
    <tr><td style="padding:4px;">Allocated net realized and unrealized gain</td>
        <td style="padding:4px;text-align:right;">302,500</td></tr>
    <tr style="font-weight:bold;border-top:1px solid #000;">
        <td style="padding:4px;">Ending capital account, September 30, 2025</td>
        <td style="padding:4px;text-align:right;">9,445,000</td></tr>
  </table>

  <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:24px;">
    <tr><td style="padding:4px;">Total commitment</td><td style="padding:4px;text-align:right;">20,000,000</td></tr>
    <tr><td style="padding:4px;">Contributed to date</td><td style="padding:4px;text-align:right;">12,600,000</td></tr>
    <tr><td style="padding:4px;">Unfunded commitment</td><td style="padding:4px;text-align:right;">7,400,000</td></tr>
  </table>
</body></html>`

describe('statement extraction — live model', { timeout: 180_000 }, () => {
  let fundId = ''
  let providerLabel = ''

  it('resolves the AI provider for the fund that has a key', async () => {
    const { data: settings } = await admin.from('fund_settings')
      .select('fund_id, claude_api_key_encrypted, openai_api_key_encrypted')
    const withKey = (settings ?? []).find((s: any) => s.claude_api_key_encrypted || s.openai_api_key_encrypted)
    expect(withKey, 'no fund has an AI key configured').toBeTruthy()
    fundId = withKey.fund_id

    const { data: fund } = await admin.from('funds').select('name').eq('id', fundId).single()
    const ai = await createFundAIProvider(admin, fundId)
    providerLabel = `${ai.providerType}/${ai.model}`
    console.log(`[ai] fund="${fund.name}" provider=${providerLabel}`)
    expect(ai.provider).toBeTruthy()
  })

  it('reads a manager PDF into validated rows', async () => {
    const pdf = await renderHtmlToPdf(STATEMENT_HTML)
    console.log(`[pdf] ${pdf.length} bytes`)

    const ai = await createFundAIProvider(admin, fundId)
    const { rows, warnings } = await readManagerDocument(ai, [
      { type: 'document', mediaType: 'application/pdf', data: pdf.toString('base64') },
    ])
    console.log('[validated]', JSON.stringify({ rows, warnings }, null, 1))

    expect(warnings).toEqual([])
    expect(rows).toHaveLength(1)
    const r = rows[0]

    expect(r.fundName).toMatch(/Meridian Growth Partners IV/i)
    // The VALUATION date (Sep 30), not the issue date (Nov 14) — the distinction the whole
    // lagged-NAV model rests on.
    expect(r.navAsOf).toBe('2025-09-30')
    expect(r.reportedNav).toBe(9_445_000)
    // The drawdown, reported POSITIVE in the calls field.
    expect(r.calls).toBe(1_250_000)
    // Parenthesised on the page; must come back positive in the distributions field, not as
    // a negative call.
    expect(r.distributions).toBe(475_000)
    expect(r.eventDate).toBe('2025-08-12')
    expect(r.sourceText).toBeTruthy()
  })

  it('leaves an unknown manager unmatched rather than guessing', async () => {
    // Laconia holds no fund holdings, so this statement should match nothing — and say so.
    const { data: holdings } = await admin.from('companies')
      .select('id, name, aliases').eq('fund_id', fundId).eq('holding_type', 'fund')
    const matched = matchHoldings(
      [{ fundName: 'Meridian Growth Partners IV, L.P.', navAsOf: '2025-09-30', reportedNav: 9_445_000, calls: 0, distributions: 0 }],
      ((holdings ?? []) as any[]).map(h => ({ id: h.id, name: h.name, aliases: h.aliases })),
    )
    console.log('[match] fund holdings on file:', (holdings ?? []).length, '| matched:', matched[0].companyId)
    expect(matched[0].companyId).toBeNull()
  })

  it('returns nothing financial for a document that is not a statement', async () => {
    const ai = await createFundAIProvider(admin, fundId)
    const { rows } = await readManagerDocument(ai, [
      { type: 'text', text: 'Dear LP, our annual general meeting will be held on 3 March at the Fairmont. Breakfast is at 8am. Please RSVP.' },
    ])
    console.log('[non-statement] rows:', rows.length)
    expect(rows).toEqual([])
  })
})
