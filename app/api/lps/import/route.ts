import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { rateLimit } from '@/lib/rate-limit'

// Max 500KB of pasted data
const MAX_INPUT_SIZE = 500_000

// Validate and coerce AI-parsed numeric values
function toSafeNumber(val: unknown): number | null {
  if (val == null) return null
  const n = Number(val)
  if (!isFinite(n)) return null
  if (Math.abs(n) > 1e15) return null // reject absurd magnitudes
  return n
}

interface ParsedInvestment {
  investor_name: string
  entity_name?: string
  portfolio_group: string
  commitment?: number | null
  total_value?: number | null
  nav?: number | null
  called_capital?: number | null
  paid_in_capital?: number | null
  distributions?: number | null
  outstanding_balance?: number | null
  dpi?: number | null
  rvpi?: number | null
  tvpi?: number | null
  irr?: number | null
}

// ---------------------------------------------------------------------------
// POST — parse pasted data with AI and upsert investors/entities/investments
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  // Rate limit: 10 per 5 minutes per user
  const limited = await rateLimit({ key: `lp-import:${user.id}`, limit: 10, windowSeconds: 300 })
  if (limited) return limited

  const body = await req.json()
  const { data: rawData, snapshotId } = body

  if (!rawData || typeof rawData !== 'string') {
    return NextResponse.json({ error: 'data is required (paste spreadsheet content)' }, { status: 400 })
  }

  if (rawData.length > MAX_INPUT_SIZE) {
    return NextResponse.json({ error: 'Input too large. Maximum 500KB of text allowed.' }, { status: 400 })
  }

  if (!snapshotId || typeof snapshotId !== 'string') {
    return NextResponse.json({ error: 'snapshotId is required' }, { status: 400 })
  }

  const fundId = writeCheck.fundId

  // Verify snapshot belongs to this fund
  const { data: snapshotCheck } = await admin
    .from('lp_snapshots' as any)
    .select('id')
    .eq('id', snapshotId)
    .eq('fund_id', fundId)
    .maybeSingle()

  if (!snapshotCheck) {
    return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 })
  }

  // Get AI provider
  let provider: Awaited<ReturnType<typeof createFundAIProvider>>['provider']
  let aiModel: string
  let aiProviderType: string
  try {
    const result = await createFundAIProvider(admin, fundId)
    provider = result.provider
    aiModel = result.model
    aiProviderType = result.providerType
  } catch {
    return NextResponse.json({ error: 'AI API key not configured. Add one in Settings.' }, { status: 400 })
  }

  // Parse with AI
  let responseText: string
  try {
    const aiResult = await provider.createMessage({
      model: aiModel,
      maxTokens: 16384,
      system: 'You are a data parser. You ONLY output valid JSON. No markdown, no code fences, no explanation, just the JSON object.',
      content: `Parse this LP investment data into JSON.

Output format:
{
  "investments": [
    {
      "investor_name": "Investor Name or LP Name",
      "entity_name": "Legal entity name if different from investor name, otherwise omit",
      "portfolio_group": "Fund name or vehicle name",
      "commitment": 1000000,
      "total_value": 1100000,
      "nav": 900000,
      "called_capital": 750000,
      "paid_in_capital": 750000,
      "distributions": 200000,
      "outstanding_balance": 250000,
      "dpi": 0.27,
      "rvpi": 1.20,
      "tvpi": 1.47,
      "irr": 0.15
    }
  ]
}

Rules:
- Each row typically represents one LP's investment in a specific fund/vehicle
- investor_name: the LP name, investor name, or limited partner name (REQUIRED)
- portfolio_group: the fund name, vehicle name, or portfolio group (REQUIRED)
- entity_name: only include if there's a separate legal entity name column distinct from investor name
- commitment: total capital commitment
- total_value: total value of the investment (distributions + NAV)
- nav: net asset value, net asset balance, residual value, or current value
- called_capital: capital called or drawn down
- paid_in_capital: paid-in capital, contributions, or capital contributed
- distributions: distributed capital, distributions received
- outstanding_balance: remaining uncalled commitment, unfunded balance
- dpi: distributions to paid-in capital ratio (as a decimal, e.g. 0.27 not 27%)
- rvpi: residual value to paid-in capital ratio (as a decimal, e.g. 1.20)
- tvpi: total value to paid-in capital ratio (as a decimal, e.g. 1.47)
- irr: internal rate of return (as a decimal, e.g. 0.15 for 15%)
- All monetary values should be plain numbers (no currency symbols, commas, or formatting)
- For ratios (DPI, RVPI, TVPI), use decimals (1.5x = 1.5)
- For percentages (IRR), convert to decimal (15% = 0.15)
- If a value is not present or cannot be determined, omit it or set to null
- Be flexible with column header names, match by meaning, not exact text
- If the data has percentage signs, "x" suffixes for multiples, or currency symbols, parse them correctly
- If you can't parse something, skip that field rather than guessing wrong

Data to parse:
${rawData}`,
    })
    responseText = aiResult.text

    logAIUsage(admin, {
      fundId,
      userId: user.id,
      provider: aiProviderType,
      model: aiModel,
      feature: 'lp-import',
      usage: aiResult.usage,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lp-import] AI API error:', message)
    return NextResponse.json({ error: 'AI API call failed. Check your API key in Settings.' }, { status: 500 })
  }

  let parsed: { investments: ParsedInvestment[] }
  try {
    // Strip markdown code fences if present
    let cleaned = responseText
      .replace(/^```(?:json)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim()

    // Try direct parse first
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      // Fallback: extract outermost JSON object
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start !== -1 && end !== -1 && end > start) {
        try {
          parsed = JSON.parse(cleaned.slice(start, end + 1))
        } catch {
          // Response may be truncated — try to repair by closing the array/object
          const partial = cleaned.slice(start)
          // Remove any trailing incomplete object (after last complete },)
          const lastComplete = partial.lastIndexOf('},')
          if (lastComplete > 0) {
            const repaired = partial.slice(0, lastComplete + 1) + ']}'
            parsed = JSON.parse(repaired)
          } else {
            throw new Error('Could not repair truncated JSON')
          }
        }
      } else {
        throw new Error('No JSON object found in response')
      }
    }
  } catch (e) {
    console.error('[lp-import] JSON parse error:', e, 'Response:', responseText.slice(0, 500))
    console.error('[lp-import] Raw AI response (first 2000 chars):', responseText.slice(0, 2000))
    return NextResponse.json({ error: 'Failed to parse AI response as JSON. The AI response may have been too large. Try importing fewer rows at a time.' }, { status: 500 })
  }

  if (!parsed.investments || !Array.isArray(parsed.investments)) {
    return NextResponse.json({ error: 'Invalid response structure, expected { investments: [...] }' }, { status: 500 })
  }

  if (parsed.investments.length > 5000) {
    return NextResponse.json({ error: 'Too many rows in parsed result (max 5000)' }, { status: 400 })
  }

  // Default commitment to paid-in capital if missing
  for (const r of parsed.investments) {
    if (!r.commitment && r.paid_in_capital) {
      r.commitment = r.paid_in_capital
    }
  }

  // Filter out rows where all financial fields are empty AND investor name looks like a header/artifact
  // Keep rows with a valid investor name even if all values are zero (e.g. GP carry recipients)
  parsed.investments = parsed.investments.filter(r => {
    const hasAnyValue =
      (r.commitment != null && r.commitment !== 0) ||
      (r.nav != null && r.nav !== 0) ||
      (r.paid_in_capital != null && r.paid_in_capital !== 0) ||
      (r.total_value != null && r.total_value !== 0) ||
      (r.distributions != null && r.distributions !== 0)
    if (hasAnyValue) return true
    // Keep zero-value rows if they have explicit zero commitment (intentional)
    if (r.commitment === 0 || r.paid_in_capital === 0) return true
    // Filter out rows with no values at all (likely parse artifacts)
    return false
  })

  // Fetch existing investors and entities for this fund
  const { data: existingInvestors } = await admin
    .from('lp_investors' as any)
    .select('id, name')
    .eq('fund_id', fundId) as { data: { id: string; name: string }[] | null; error: any }

  const investorByName = new Map<string, string>()
  for (const inv of existingInvestors ?? []) {
    investorByName.set(inv.name.toLowerCase(), inv.id)
  }

  const { data: existingEntities } = await admin
    .from('lp_entities' as any)
    .select('id, entity_name, investor_id')
    .eq('fund_id', fundId) as { data: { id: string; entity_name: string; investor_id: string }[] | null; error: any }

  const entityByName = new Map<string, string>()
  for (const ent of existingEntities ?? []) {
    entityByName.set(ent.entity_name.toLowerCase(), ent.id)
  }

  const errors: string[] = []
  let created = 0
  let updated = 0

  for (let i = 0; i < parsed.investments.length; i++) {
    const row = parsed.investments[i]
    const rowLabel = `Row ${i + 1}`

    if (!row.investor_name || typeof row.investor_name !== 'string' || !row.investor_name.trim()) {
      errors.push(`${rowLabel}: missing investor name`)
      continue
    }
    if (!row.portfolio_group || typeof row.portfolio_group !== 'string' || !row.portfolio_group.trim()) {
      errors.push(`${rowLabel}: missing portfolio group/fund`)
      continue
    }

    const investorName = row.investor_name.trim().slice(0, 500)
    const entityName = (row.entity_name?.trim() || investorName).slice(0, 500)
    const portfolioGroup = row.portfolio_group.trim().slice(0, 500)

    // Check if entity already exists (may have been merged to a different investor)
    let entityId = entityByName.get(entityName.toLowerCase())
    let investorId: string | undefined

    if (entityId) {
      // Entity exists — use its current investor (respects prior merges)
      const existing = (existingEntities ?? []).find(e => e.id === entityId)
      if (existing) investorId = existing.investor_id
    }

    // Upsert investor (only if entity didn't already resolve one)
    if (!investorId) {
      investorId = investorByName.get(investorName.toLowerCase())
      if (!investorId) {
        const { data: newInv, error: invErr } = await admin
          .from('lp_investors' as any)
          .insert({ fund_id: fundId, name: investorName })
          .select('id')
          .single() as { data: { id: string } | null; error: any }

        if (invErr || !newInv) {
          errors.push(`${rowLabel}: failed to create investor "${investorName}"`)
          continue
        }
        investorId = newInv.id
        investorByName.set(investorName.toLowerCase(), investorId)
      }
    }

    // Upsert entity
    if (!entityId) {
      const { data: newEnt, error: entErr } = await admin
        .from('lp_entities' as any)
        .insert({ fund_id: fundId, investor_id: investorId, entity_name: entityName })
        .select('id')
        .single() as { data: { id: string } | null; error: any }

      if (entErr || !newEnt) {
        errors.push(`${rowLabel}: failed to create entity "${entityName}"`)
        continue
      }
      entityId = newEnt.id
      entityByName.set(entityName.toLowerCase(), entityId)
    }

    // Build investment data — all fields for insert (validated)
    const investmentData: Record<string, any> = {
      commitment: toSafeNumber(row.commitment),
      total_value: toSafeNumber(row.total_value),
      nav: toSafeNumber(row.nav),
      called_capital: toSafeNumber(row.called_capital),
      paid_in_capital: toSafeNumber(row.paid_in_capital),
      distributions: toSafeNumber(row.distributions),
      outstanding_balance: toSafeNumber(row.outstanding_balance),
      dpi: toSafeNumber(row.dpi),
      rvpi: toSafeNumber(row.rvpi),
      tvpi: toSafeNumber(row.tvpi),
      irr: toSafeNumber(row.irr),
      snapshot_id: snapshotId,
      updated_at: new Date().toISOString(),
    }

    // Upsert investment (by unique constraint: fund_id, entity_id, portfolio_group, snapshot_id)
    const { data: existing } = await admin
      .from('lp_investments' as any)
      .select('id')
      .eq('fund_id', fundId)
      .eq('entity_id', entityId)
      .eq('portfolio_group', portfolioGroup)
      .eq('snapshot_id', snapshotId)
      .maybeSingle() as { data: { id: string } | null; error: any }

    if (existing) {
      // On update, only overwrite fields that the import actually provided —
      // preserve existing values (like IRR) that may not be in the new data
      const updateData: Record<string, any> = { updated_at: new Date().toISOString() }
      if (row.commitment != null) updateData.commitment = toSafeNumber(row.commitment)
      if (row.total_value != null) updateData.total_value = toSafeNumber(row.total_value)
      if (row.nav != null) updateData.nav = toSafeNumber(row.nav)
      if (row.called_capital != null) updateData.called_capital = toSafeNumber(row.called_capital)
      if (row.paid_in_capital != null) updateData.paid_in_capital = toSafeNumber(row.paid_in_capital)
      if (row.distributions != null) updateData.distributions = toSafeNumber(row.distributions)
      if (row.outstanding_balance != null) updateData.outstanding_balance = toSafeNumber(row.outstanding_balance)
      if (row.dpi != null) updateData.dpi = toSafeNumber(row.dpi)
      if (row.rvpi != null) updateData.rvpi = toSafeNumber(row.rvpi)
      if (row.tvpi != null) updateData.tvpi = toSafeNumber(row.tvpi)
      if (row.irr != null) updateData.irr = toSafeNumber(row.irr)

      const { error: upErr } = await admin
        .from('lp_investments' as any)
        .update(updateData)
        .eq('id', existing.id)

      if (upErr) {
        // A report already shared with investors is locked (lp_investments_locked_when_shared).
        errors.push(/shared with investors/.test(upErr.message ?? '')
          ? `${rowLabel}: this report is shared with investors and locked — unshare it, or import into a new report`
          : `${rowLabel}: failed to update investment`)
      } else {
        updated++
      }
    } else {
      const { error: insErr } = await admin
        .from('lp_investments' as any)
        .insert({
          fund_id: fundId,
          entity_id: entityId,
          portfolio_group: portfolioGroup,
          ...investmentData,
        })

      if (insErr) {
        errors.push(`${rowLabel}: failed to create investment`)
      } else {
        created++
      }
    }
  }

  return NextResponse.json({ created, updated, errors })
}
