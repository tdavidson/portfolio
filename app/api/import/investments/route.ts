import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { logActivity } from '@/lib/activity'
import { rateLimit } from '@/lib/rate-limit'
import { draftEntryForTransaction } from '@/lib/accounting/from-portfolio'
import { normalizeSecurityType, SECURITY_TYPES } from '@/lib/accounting/soi'
import { ensureVehiclesByName } from '@/lib/accounting/vehicle-id'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { groupWriteDenial } from '@/lib/access/scope'

interface ParsedTransaction {
  company_name: string
  company_status?: 'active' | 'exited' | 'written-off'
  transaction_type: 'investment' | 'proceeds' | 'unrealized_gain_change' | 'round_info'
  round_name?: string
  transaction_date?: string
  notes?: string
  investment_cost?: number
  interest_converted?: number
  shares_acquired?: number
  share_price?: number
  cost_basis_exited?: number
  proceeds_received?: number
  proceeds_escrow?: number
  proceeds_written_off?: number
  proceeds_per_share?: number
  unrealized_value_change?: number
  current_share_price?: number
  postmoney_valuation?: number
  latest_postmoney_valuation?: number
  exit_valuation?: number
  /**
   * The instrument, feeding the SOI's by-asset-type breakout. CHECK-constrained in the DB — see
   * SECURITY_TYPES. Whatever the model returns goes through normalizeSecurityType(), because this
   * arrives from an LLM reading someone's spreadsheet and "Series A Preferred" is not a valid value.
   */
  security_type?: string
  /** 'mark' | 'fx' — keeps a currency move out of investment performance. */
  valuation_change_source?: string
  fx_value_change?: number
  fx_rate?: number
  prior_fx_rate?: number
  original_currency?: string
  original_investment_cost?: number
  original_share_price?: number
  original_postmoney_valuation?: number
  original_proceeds_received?: number
  original_proceeds_per_share?: number
  original_exit_valuation?: number
  original_unrealized_value_change?: number
  original_current_share_price?: number
  original_latest_postmoney_valuation?: number
  portfolio_group?: string
}

const VALID_TYPES = new Set(['investment', 'proceeds', 'unrealized_gain_change', 'round_info'])

function sanitize(val: string): string {
  return val
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, 10_000)
}

// ---------------------------------------------------------------------------
// POST — bulk import investment transactions via AI parsing
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const limited = await rateLimit({ key: `import-investments:${user.id}`, limit: 10, windowSeconds: 300 })
  if (limited) return limited

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const fundId = membership.fund_id
  const body = await req.json()
  const { text } = body

  if (typeof text !== 'string' || !text.trim()) {
    return NextResponse.json({ error: 'No text provided' }, { status: 400 })
  }

  if (text.length > 500_000) {
    return NextResponse.json({ error: 'Input too large. Maximum 500KB of text allowed.' }, { status: 400 })
  }

  // Get AI provider
  let provider: Awaited<ReturnType<typeof createFundAIProvider>>['provider']
  let claudeModel: string
  let aiProviderType: string
  try {
    const result = await createFundAIProvider(admin, fundId)
    provider = result.provider
    claudeModel = result.model
    aiProviderType = result.providerType
  } catch {
    return NextResponse.json({ error: 'AI API key not configured. Add one in Settings.' }, { status: 400 })
  }

  let responseText: string
  try {
    const aiResult = await provider.createMessage({
      model: claudeModel,
      maxTokens: 8192,
      content: `Parse the following investment data (CSV, spreadsheet, or free-form text) into structured JSON.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "transactions": [
    {
      "company_name": "Company Name",
      "company_status": "active",
      "transaction_type": "investment",
      "round_name": "Series A",
      "transaction_date": "2024-01-15",
      "investment_cost": 500000,
      "interest_converted": 0,
      "shares_acquired": 50000,
      "share_price": 10.00
    },
    {
      "company_name": "Company Name",
      "company_status": "exited",
      "transaction_type": "proceeds",
      "round_name": "Exit",
      "transaction_date": "2025-06-01",
      "cost_basis_exited": 500000,
      "proceeds_received": 1500000,
      "proceeds_escrow": 100000,
      "proceeds_written_off": 0,
      "proceeds_per_share": 30.00
    },
    {
      "company_name": "Company Name",
      "company_status": "active",
      "transaction_type": "unrealized_gain_change",
      "round_name": "Series B",
      "transaction_date": "2025-12-31",
      "unrealized_value_change": 200000,
      "current_share_price": 14.00
    },
    {
      "company_name": "Company Name",
      "company_status": "active",
      "transaction_type": "round_info",
      "round_name": "Series C",
      "transaction_date": "2026-01-15",
      "share_price": 18.00,
      "postmoney_valuation": 500000000
    }
  ]
}

Rules:
- transaction_type must be one of: "investment", "proceeds", "unrealized_gain_change", "round_info"
- security_type is OPTIONAL and, if the source names the instrument, must be EXACTLY one of: ${SECURITY_TYPES.map(t => `"${t}"`).join(', ')}. Map what you read onto that list ("Series A Preferred" -> "preferred", "Convertible Promissory Note" -> "convertible_note"). If the instrument is unclear, OMIT the field rather than guessing
- company_status must be one of: "active", "exited", "written-off". Infer from context: if there are proceeds/exit transactions, use "exited"; if marked as written off or loss, use "written-off"; otherwise default to "active"
- Dates should be in YYYY-MM-DD format
- All monetary values should be plain numbers (no currency symbols)
- For investment rows: include investment_cost, shares_acquired, share_price, and optionally interest_converted, postmoney_valuation
- For proceeds rows: include proceeds_received, and optionally cost_basis_exited, proceeds_escrow, proceeds_written_off, proceeds_per_share, exit_valuation
- For unrealized_gain_change rows: include current_share_price, and optionally unrealized_value_change, latest_postmoney_valuation
- For round_info rows: record a funding round the fund did NOT participate in. Include share_price, and optionally postmoney_valuation. This captures round details for reference and updates the latest share price
- If amounts are in a different currency than fund currency, include original_currency (ISO 4217 code like "EUR", "GBP") and the original_* versions of relevant monetary fields
- Use the company name exactly as it appears in the data
- If the data has column headers like "Cost", "Amount Invested", "Investment Amount" those map to investment_cost
- "Shares", "# Shares" maps to shares_acquired
- "Price/Share", "Share Price" maps to share_price
- "Proceeds", "Exit Proceeds", "Amount Received" maps to proceeds_received
- If the data describes valuations or current fair market value, create unrealized_gain_change entries
- If the data includes a portfolio group, fund name, or vehicle (e.g. "Fund I", "SPV 1"), set portfolio_group to that string value
- If you can't determine the transaction type, default to "investment"

Schedule of Investments (SOI) handling:
- SOIs are point-in-time snapshots from fund administrators showing each position's cost basis and current fair value
- For each position in an SOI, create TWO transactions:
  1. An "investment" row with investment_cost set to the cost basis (and shares_acquired/share_price if available)
  2. An "unrealized_gain_change" row with current_share_price set to the fair value per share, or if only total fair value is given, set unrealized_value_change to (fair_value - cost_basis)
- Common SOI column names: "Cost", "Cost Basis", "Original Cost" → investment_cost; "Fair Value", "FMV", "Market Value", "Carrying Value", "Current Value" → use for unrealized_gain_change; "Unrealized Gain/Loss", "Appreciation/Depreciation" → unrealized_value_change
- If the SOI has a report date or "as of" date, use that as transaction_date for all rows
- If a position shows zero cost and zero value, or is marked "written off" / "written down to zero", set company_status to "written-off"
- If a position shows realized proceeds or is marked as exited/distributed, create a "proceeds" row instead of unrealized_gain_change

Data to parse:
${text}`,
    })
    responseText = aiResult.text

    logAIUsage(admin, {
      fundId,
      userId: user.id,
      provider: aiProviderType,
      model: claudeModel,
      feature: 'import.investments',
      usage: aiResult.usage,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[import-investments] AI API error:', message)
    return NextResponse.json({ error: 'AI API call failed. Check your API key in Settings.' }, { status: 500 })
  }

  let parsed: { transactions: ParsedTransaction[] }
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response')
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return NextResponse.json({
      error: 'Failed to parse AI response as JSON. Try importing fewer rows at a time.',
    }, { status: 500 })
  }

  if (!parsed.transactions || !Array.isArray(parsed.transactions)) {
    return NextResponse.json({ error: 'Invalid response structure' }, { status: 500 })
  }

  if (parsed.transactions.length > 5000) {
    return NextResponse.json({ error: 'Too many transactions in parsed result (max 5000)' }, { status: 400 })
  }

  // Every stored portfolio_group name must be backed by a real fund_vehicles row — never a
  // disconnected string. The importer is the biggest source of orphan vehicle names (an LLM
  // free-typing "Fund I" / "SPV 1" straight into the column), so resolve/create every distinct
  // name ONCE up front rather than per-row.
  // Only into the importer's own entities, checked before ensureVehiclesByName could create one
  // they cannot see. One refusal stops the import: a partial import silently missing rows is worse.
  const scope = await loadEntityScope(admin, writeCheck)
  for (const t of parsed.transactions) {
    const denied = groupWriteDenial(scope.vehicleNames, t.portfolio_group)
    if (denied) return NextResponse.json({ error: `${t.company_name ?? 'A row'}: ${denied}` }, { status: 403 })
  }
  await ensureVehiclesByName(admin, fundId, parsed.transactions.map(t => t.portfolio_group))

  // Get existing companies for matching
  const { data: existingCompanies } = await admin
    .from('companies')
    .select('id, name')
    .eq('fund_id', fundId)
    .eq('holding_type', 'company')   // fund holdings have their own surfaces

  const companyByName = new Map(
    (existingCompanies ?? []).map(c => [c.name.toLowerCase(), c.id])
  )

  const results = {
    investmentsCreated: 0,
    proceedsCreated: 0,
    unrealizedCreated: 0,
    companiesMatched: 0,
    companiesCreated: 0,
    /** Entries posted on record — marks and anything else with no cash leg. */
    entriesPosted: 0,
    // Kept as drafts because their partner allocation failed — see draftEntryForTransaction.
    entriesDrafted: 0,
    errors: [] as string[],
    /** Rows that were imported but implied no ledger entry, and why. Reported, not swallowed —
     *  "10 imported, 0 booked" is something the user must be told, not left to discover. */
    ledgerSkips: [] as string[],
  }

  const ledgerSkips = results.ledgerSkips
  const matchedCompanies = new Set<string>()

  for (const pt of parsed.transactions) {
    if (!pt.company_name || typeof pt.company_name !== 'string' || !pt.company_name.trim()) {
      results.errors.push('Skipped transaction with no company name')
      continue
    }

    const companyName = sanitize(pt.company_name)
    if (!companyName) {
      results.errors.push('Skipped transaction with empty company name after sanitization')
      continue
    }

    let companyId = companyByName.get(companyName.toLowerCase())
    if (!companyId) {
      // Auto-create the company
      const status = (['active', 'exited', 'written-off'] as const).includes(pt.company_status as any)
        ? pt.company_status!
        : 'active'
      const { data: newCompany, error: companyError } = await admin
        .from('companies')
        .insert({
          fund_id: fundId,
          name: companyName,
          status,
          tags: [],
        })
        .select('id')
        .single()

      if (companyError || !newCompany) {
        results.errors.push(`Failed to create company "${companyName}": ${companyError?.message}`)
        continue
      }

      companyId = newCompany.id
      companyByName.set(companyName.toLowerCase(), companyId)
      results.companiesCreated++
    }

    if (!matchedCompanies.has(companyId)) {
      matchedCompanies.add(companyId)
      results.companiesMatched++
    }

    const txnType = pt.transaction_type
    if (!txnType || !VALID_TYPES.has(txnType)) {
      results.errors.push(`Invalid transaction type "${txnType}" for "${companyName}"`)
      continue
    }

    // Unlike transaction_type, an unrecognised instrument does NOT skip the row. security_type is a
    // label on the Schedule of Investments; the cost, shares and proceeds on this row are the money.
    // Dropping the transaction because a model wrote "Series A-1 Pfd" would lose the position to
    // save the caption — so the caption goes, the position stays, and the import says so. Left null,
    // the SOI falls back to its derived priced-equity/convertible proxy.
    const security_type = pt.security_type ? normalizeSecurityType(pt.security_type) : null
    if (pt.security_type && !security_type) {
      results.errors.push(
        `Unrecognised security type "${pt.security_type}" for "${companyName}" — imported without ` +
        `an instrument. Set it on the transaction if the asset-type breakout matters.`,
      )
    }

    const { data: inserted, error: insertError } = await admin
      .from('investment_transactions' as any)
      .insert({
        company_id: companyId,
        fund_id: fundId,
        transaction_type: txnType,
        round_name: pt.round_name ? sanitize(pt.round_name) : null,
        transaction_date: pt.transaction_date || null,
        notes: pt.notes ? sanitize(pt.notes) : null,
        investment_cost: pt.investment_cost ?? null,
        interest_converted: pt.interest_converted ?? 0,
        shares_acquired: pt.shares_acquired ?? null,
        share_price: pt.share_price ?? null,
        cost_basis_exited: pt.cost_basis_exited ?? null,
        proceeds_received: pt.proceeds_received ?? null,
        proceeds_escrow: pt.proceeds_escrow ?? 0,
        proceeds_written_off: pt.proceeds_written_off ?? 0,
        proceeds_per_share: pt.proceeds_per_share ?? null,
        unrealized_value_change: pt.unrealized_value_change ?? null,
        current_share_price: pt.current_share_price ?? null,
        postmoney_valuation: pt.postmoney_valuation ?? null,
        latest_postmoney_valuation: pt.latest_postmoney_valuation ?? null,
        exit_valuation: pt.exit_valuation ?? null,
        original_currency: pt.original_currency ?? null,
        original_investment_cost: pt.original_investment_cost ?? null,
        original_share_price: pt.original_share_price ?? null,
        original_postmoney_valuation: pt.original_postmoney_valuation ?? null,
        original_proceeds_received: pt.original_proceeds_received ?? null,
        original_proceeds_per_share: pt.original_proceeds_per_share ?? null,
        original_exit_valuation: pt.original_exit_valuation ?? null,
        original_unrealized_value_change: pt.original_unrealized_value_change ?? null,
        original_current_share_price: pt.original_current_share_price ?? null,
        original_latest_postmoney_valuation: pt.original_latest_postmoney_valuation ?? null,
        portfolio_group: pt.portfolio_group ?? null,
        // These three were silently dropped by the importer even though the single-create
        // route writes them. `security_type` feeds the SOI's by-asset-type breakout;
        // `valuation_change_source` + `fx_value_change` are what keep a currency move out of
        // investment performance (1250/4300 rather than 1200/4200).
        security_type,
        valuation_change_source: pt.valuation_change_source ?? null,
        fx_value_change: pt.fx_value_change ?? null,
        fx_rate: pt.fx_rate ?? null,
        prior_fx_rate: pt.prior_fx_rate ?? null,
      })
      .select('*')
      .single()

    if (insertError) {
      results.errors.push(`Failed to insert ${txnType} for "${companyName}": ${insertError.message}`)
      continue
    }

    if (txnType === 'investment') results.investmentsCreated++
    else if (txnType === 'proceeds') results.proceedsCreated++
    else if (txnType === 'unrealized_gain_change') results.unrealizedCreated++

    // Mirror to the ledger, exactly as the single-create route does. Without this an imported
    // portfolio silently diverged from the books — every position present in the tracker and
    // absent from the ledger — until someone happened to run a bootstrap or replay.
    //
    // Non-fatal by design: the import must not fail because a vehicle has no chart of
    // accounts. Reasons are collected and reported, never swallowed.
    if (inserted) {
      const draft = await draftEntryForTransaction(admin, fundId, user.id, inserted, companyName)
      if (draft.drafted) draft.posted ? results.entriesPosted++ : results.entriesDrafted++
      else if (draft.reason) ledgerSkips.push(`${companyName} (${txnType}): ${draft.reason}`)
    }
  }

  logActivity(admin, fundId, user.id, 'import.investments', {
    investmentsCreated: results.investmentsCreated,
    proceedsCreated: results.proceedsCreated,
    unrealizedCreated: results.unrealizedCreated,
    companiesCreated: results.companiesCreated,
    companiesMatched: results.companiesMatched,
  })

  return NextResponse.json(results)
}
