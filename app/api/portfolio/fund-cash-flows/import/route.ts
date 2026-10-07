import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { rateLimit } from '@/lib/rate-limit'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { groupWriteDenial } from '@/lib/access/scope'

const MAX_INPUT_SIZE = 500_000

function toSafeNumber(val: unknown): number | null {
  if (val == null) return null
  const n = Number(val)
  if (!isFinite(n)) return null
  if (Math.abs(n) > 1e15) return null
  return n
}

interface ParsedCashFlow {
  portfolio_group: string
  flow_date: string
  flow_type: 'commitment' | 'called_capital' | 'distribution'
  amount: number
  notes?: string | null
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const limited = await rateLimit({ key: `fund-cf-import:${user.id}`, limit: 10, windowSeconds: 300 })
  if (limited) return limited

  const body = await req.json()
  const { data: rawData } = body

  if (!rawData || typeof rawData !== 'string') {
    return NextResponse.json({ error: 'data is required (paste spreadsheet content)' }, { status: 400 })
  }

  if (rawData.length > MAX_INPUT_SIZE) {
    return NextResponse.json({ error: 'Input too large. Maximum 500KB.' }, { status: 400 })
  }

  const fundId = writeCheck.fundId

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

  let responseText: string
  try {
    const aiResult = await provider.createMessage({
      model: aiModel,
      maxTokens: 16384,
      system: 'You are a data parser. You ONLY output valid JSON. No markdown, no code fences, no explanation, just the JSON object.',
      content: `Parse this fund cash flow data into JSON.

Output format:
{
  "cash_flows": [
    {
      "portfolio_group": "Fund III",
      "flow_date": "2024-01-15",
      "flow_type": "commitment",
      "amount": 1000000,
      "notes": "Initial commitment"
    }
  ]
}

Rules:
- portfolio_group: the fund name, vehicle name, or portfolio group (REQUIRED)
- flow_date: the date of the cash flow in YYYY-MM-DD format (REQUIRED)
- flow_type: must be exactly one of: "commitment", "called_capital", "distribution" (REQUIRED)
  - "commitment" = total capital commitment, subscription, commitment amount
  - "called_capital" = capital call, drawdown, contribution, paid-in capital, capital called
  - "distribution" = distribution, return of capital, proceeds
- amount: the monetary amount as a positive number (REQUIRED, must be > 0)
- notes: optional description or notes
- All monetary values should be plain numbers (no currency symbols, commas, or formatting)
- Dates should be YYYY-MM-DD format, convert from any input format
- Be flexible with column headers, match by meaning, not exact text
- If the data includes a "type" or "transaction type" column, map it to the correct flow_type
- If data has multiple funds/groups, use the group/fund column to set portfolio_group
- If a row doesn't have enough data to determine the required fields, skip it

Data to parse:
${rawData}`,
    })
    responseText = aiResult.text

    logAIUsage(admin, {
      fundId,
      userId: user.id,
      provider: aiProviderType,
      model: aiModel,
      feature: 'fund-cf-import',
      usage: aiResult.usage,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[fund-cf-import] AI API error:', message)
    return NextResponse.json({ error: 'AI API call failed. Check your API key in Settings.' }, { status: 500 })
  }

  let parsed: { cash_flows: ParsedCashFlow[] }
  try {
    let cleaned = responseText
      .replace(/^```(?:json)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim()

    try {
      parsed = JSON.parse(cleaned)
    } catch {
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start !== -1 && end !== -1 && end > start) {
        try {
          parsed = JSON.parse(cleaned.slice(start, end + 1))
        } catch {
          const partial = cleaned.slice(start)
          const lastComplete = partial.lastIndexOf('},')
          if (lastComplete > 0) {
            parsed = JSON.parse(partial.slice(0, lastComplete + 1) + ']}')
          } else {
            throw new Error('Could not parse JSON')
          }
        }
      } else {
        throw new Error('No JSON found in response')
      }
    }
  } catch (err) {
    console.error('[fund-cf-import] JSON parse error:', err, 'Response:', responseText.slice(0, 500))
    return NextResponse.json({ error: 'Failed to parse AI response. Try simplifying the input.' }, { status: 500 })
  }

  if (!Array.isArray(parsed.cash_flows) || parsed.cash_flows.length === 0) {
    return NextResponse.json({ error: 'No cash flows could be parsed from the input.' }, { status: 400 })
  }

  // Rows only into the caller's own entities.
  const writeScope = await loadEntityScope(admin, writeCheck)
  const validFlowTypes = ['commitment', 'called_capital', 'distribution']
  const errors: string[] = []
  let created = 0

  for (let i = 0; i < parsed.cash_flows.length; i++) {
    const cf = parsed.cash_flows[i]

    if (!cf.portfolio_group || !cf.flow_date || !cf.flow_type || !cf.amount) {
      errors.push(`Row ${i + 1}: missing required fields`)
      continue
    }

    const denied = groupWriteDenial(writeScope.vehicleNames, String(cf.portfolio_group).trim())
    if (denied) {
      errors.push(`Row ${i + 1}: ${denied}`)
      continue
    }

    if (!validFlowTypes.includes(cf.flow_type)) {
      errors.push(`Row ${i + 1}: invalid flow_type "${cf.flow_type}"`)
      continue
    }

    const amount = toSafeNumber(cf.amount)
    if (amount == null || amount <= 0) {
      errors.push(`Row ${i + 1}: invalid amount`)
      continue
    }

    // Validate date format
    const dateMatch = String(cf.flow_date).match(/^\d{4}-\d{2}-\d{2}$/)
    if (!dateMatch) {
      errors.push(`Row ${i + 1}: invalid date format "${cf.flow_date}"`)
      continue
    }

    const { error: insertError } = await admin
      .from('fund_cash_flows' as any)
      .insert({
        fund_id: fundId,
        portfolio_group: String(cf.portfolio_group).trim(),
        flow_date: cf.flow_date,
        flow_type: cf.flow_type,
        amount,
        notes: cf.notes ? String(cf.notes).trim() : null,
      })

    if (insertError) {
      errors.push(`Row ${i + 1}: ${insertError.message}`)
    } else {
      created++
    }
  }

  return NextResponse.json({ created, errors })
}
