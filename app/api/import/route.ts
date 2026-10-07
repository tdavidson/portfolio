import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { logActivity } from '@/lib/activity'
import { rateLimit } from '@/lib/rate-limit'
import { loadEntityScope } from '@/lib/access/entity-scope'

interface ParsedMetric {
  name: string
  unit?: string
  unit_position?: 'prefix' | 'suffix'
  value_type?: 'number' | 'currency' | 'percentage' | 'text'
  cadence?: 'monthly' | 'quarterly' | 'annual'
  historical_values?: Array<{
    period: string
    value: number | string
  }>
}

interface ParsedCompany {
  name: string
  tags?: string[]
  sender_emails?: string[]
  summary?: string
  stage?: string
  industry?: string
  overview?: string
  founders?: string
  why_invested?: string
  current_update?: string
  contact_email?: string
  metrics?: ParsedMetric[]
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Strip HTML tags, control chars, and cap length to prevent XSS / buffer issues */
function sanitize(val: string): string {
  return val
    .replace(/<[^>]*>/g, '')                              // strip HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // strip control chars
    .trim()
    .slice(0, 10_000)                                     // hard length cap per field
}

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function parsePeriodLabel(period: string): {
  label: string
  year: number
  quarter: number | null
  month: number | null
} {
  const label = period.trim()

  // Try Q1 2025 format
  const qMatch = label.match(/Q(\d)\s+(\d{4})/)
  if (qMatch) {
    return {
      label,
      year: parseInt(qMatch[2]),
      quarter: parseInt(qMatch[1]),
      month: null,
    }
  }

  // Try month name + year (e.g. "January 2025", "Jan 2025")
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ]
  const monthAbbrs = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

  for (let i = 0; i < months.length; i++) {
    const re = new RegExp(`(?:${months[i]}|${monthAbbrs[i]})\\s+(\\d{4})`, 'i')
    const m = label.match(re)
    if (m) {
      return {
        label,
        year: parseInt(m[1]),
        quarter: null,
        month: i + 1,
      }
    }
  }

  // Try year only
  const yearMatch = label.match(/^(\d{4})$/)
  if (yearMatch) {
    return { label, year: parseInt(yearMatch[1]), quarter: null, month: null }
  }

  // Fallback
  return { label, year: new Date().getFullYear(), quarter: null, month: null }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Rate limit import: 10 per 5 minutes per user
  const limited = await rateLimit({ key: `import:${user.id}`, limit: 10, windowSeconds: 300 })
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

  // --- Input validation ---
  if (typeof text !== 'string' || !text.trim()) {
    return NextResponse.json({ error: 'No text provided' }, { status: 400 })
  }

  if (text.length > 500_000) {
    return NextResponse.json({ error: 'Input too large. Maximum 500KB of text allowed.' }, { status: 400 })
  }

  // Get AI provider + model
  let provider: Awaited<ReturnType<typeof createFundAIProvider>>['provider']
  let claudeModel: string
  let aiProviderType: string
  try {
    const result = await createFundAIProvider(admin, fundId)
    provider = result.provider
    claudeModel = result.model
    aiProviderType = result.providerType
  } catch {
    return NextResponse.json({ error: 'Claude API key not configured. Add one in Settings.' }, { status: 400 })
  }

  // Parse with AI
  let responseText: string
  try {
    const aiResult = await provider.createMessage({
      model: claudeModel,
      maxTokens: 8192,
      content: `Parse the following spreadsheet/CSV data into structured JSON. Extract companies with their details and metrics.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "companies": [
    {
      "name": "Company Name",
      "tags": ["Fund I"],
      "sender_emails": ["email@example.com"],
      "summary": "Brief business description",
      "stage": "Series A",
      "industry": "SaaS",
      "overview": "Company overview paragraph",
      "founders": "Jane Doe, John Smith",
      "why_invested": "Investment thesis",
      "current_update": "Latest business update",
      "contact_email": "founder@company.com",
      "metrics": [
        {
          "name": "MRR",
          "unit": "$",
          "unit_position": "prefix",
          "value_type": "currency",
          "cadence": "monthly",
          "historical_values": [
            { "period": "Q1 2025", "value": 50000 }
          ]
        }
      ]
    }
  ]
}

Rules:
- Each row likely represents a company
- Look for columns like: company name, fund, email, industry/sector, stage, description/summary, founders, contact email, overview, investment thesis
- Look for metric columns with values (revenue, MRR, ARR, headcount, burn rate, etc.)
- The "fund" column maps to tags (e.g. "Fund I", "Fund II")
- value_type: use "currency" for dollar amounts, "percentage" for percentages, "number" for counts
- unit_position: "prefix" for currency ($), "suffix" for percent (%)
- If a column header looks like a period (Q1 2025, Jan 2025, 2024), those are historical metric values
- Infer the metric name from the row label or column group header
- If two columns represent the same metric with different names (e.g. "Revenue" and "Rev"), combine them under one metric
- If the data has free-form text describing metrics, extract numeric values and create appropriate metrics
- Infer the reporting period from context (column headers, dates, labels)
- Map "sector" fields to "industry"
- If you can't parse something, skip it rather than guessing wrong

Data to parse:
${text}`,
    })
    responseText = aiResult.text

    logAIUsage(admin, {
      fundId,
      userId: user.id,
      provider: aiProviderType,
      model: claudeModel,
      feature: 'import',
      usage: aiResult.usage,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[import] Claude API error:', message)
    return NextResponse.json({
      error: 'AI API call failed. Check your API key in Settings.',
    }, { status: 500 })
  }

  let parsed: { companies: ParsedCompany[] }
  try {
    // Try to extract JSON from the response (handle possible markdown wrapping)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response')
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return NextResponse.json({
      error: 'Failed to parse AI response as JSON. Try importing fewer rows at a time.',
    }, { status: 500 })
  }

  // --- Structure validation ---
  if (!parsed.companies || !Array.isArray(parsed.companies)) {
    return NextResponse.json({ error: 'Invalid response structure' }, { status: 500 })
  }

  if (parsed.companies.length > 1000) {
    return NextResponse.json({ error: 'Too many companies in parsed result (max 1000)' }, { status: 400 })
  }

  // Get existing companies for matching
  const { data: existingCompanies } = await admin
    .from('companies')
    .select('id, name')
    .eq('fund_id', fundId)
    .eq('holding_type', 'company')   // fund holdings have their own surfaces

  // A member imports only into companies they can see: matching is among those, and a row naming
  // any other company is reported, not created (a new company would be linked to no entity, so they
  // would lose it — and matching an invisible one would write into another fund's company).
  const importScope = await loadEntityScope(admin, writeCheck)
  const visibleCompanies = importScope.companyIds
  const companyByName = new Map(
    (existingCompanies ?? []).filter(c => visibleCompanies === null || visibleCompanies.includes(c.id))
      .map(c => [c.name.toLowerCase(), c.id])
  )

  // Get existing senders for dedup
  const { data: existingSenders } = await admin
    .from('authorized_senders')
    .select('email')
    .eq('fund_id', fundId)
  const existingSenderEmails = new Set(
    (existingSenders ?? []).map(s => (s.email as string).toLowerCase())
  )

  const results = {
    companiesCreated: 0,
    companiesMatched: 0,
    companiesUpdated: 0,
    metricsCreated: 0,
    metricsMatched: 0,
    metricValuesCreated: 0,
    metricValuesSkipped: 0,
    sendersCreated: 0,
    errors: [] as string[],
  }

  for (const pc of parsed.companies) {
    // Validate company entry
    if (!pc.name || typeof pc.name !== 'string' || !pc.name.trim()) {
      results.errors.push('Skipped company with no name')
      continue
    }

    const companyName = sanitize(pc.name)
    if (!companyName) {
      results.errors.push('Skipped company with empty name after sanitization')
      continue
    }

    let companyId = companyByName.get(companyName.toLowerCase())

    // Build field values (sanitized)
    const companyFields: Record<string, unknown> = {}
    if (pc.industry) {
      const ind = sanitize(pc.industry)
      companyFields.industry = ind ? [ind] : null
    }
    if (pc.overview) companyFields.overview = sanitize(pc.overview) || null
    if (pc.founders) companyFields.founders = sanitize(pc.founders) || null
    if (pc.why_invested) companyFields.why_invested = sanitize(pc.why_invested) || null
    if (pc.current_update) companyFields.current_update = sanitize(pc.current_update) || null
    if (pc.contact_email) {
      const email = sanitize(pc.contact_email)
      if (isValidEmail(email)) companyFields.contact_email = [email]
    }
    if (pc.stage) companyFields.stage = sanitize(pc.stage) || null
    if (pc.summary) companyFields.notes = sanitize(pc.summary) || null

    if (companyId) {
      // Company already exists — update with new field values if any
      results.companiesMatched++

      const updateFields: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(companyFields)) {
        if (val != null) updateFields[key] = val
      }

      if (Object.keys(updateFields).length > 0) {
        const { error: updateError } = await admin
          .from('companies')
          .update(updateFields)
          .eq('id', companyId)

        if (!updateError) {
          results.companiesUpdated++
        } else {
          results.errors.push(`Failed to update company "${companyName}": ${updateError.message}`)
        }
      }
    } else if (visibleCompanies !== null) {
      results.errors.push(`"${companyName}" is not one of your companies — ask an admin to add it to an entity first.`)
      continue
    } else {
      // Create company
      const sanitizedTags = Array.isArray(pc.tags)
        ? pc.tags.filter(t => typeof t === 'string').map(t => sanitize(t)).filter(Boolean)
        : []

      const { data: newCompany, error: companyError } = await admin
        .from('companies')
        .insert({
          fund_id: fundId,
          name: companyName,
          tags: sanitizedTags,
          status: 'active',
          ...companyFields,
        })
        .select('id')
        .single()

      if (companyError || !newCompany) {
        results.errors.push(`Failed to create company "${companyName}": ${companyError?.message}`)
        continue
      }

      companyId = newCompany.id
      results.companiesCreated++
      companyByName.set(companyName.toLowerCase(), companyId)
    }

    // Create authorized senders (skip duplicates)
    if (Array.isArray(pc.sender_emails)) {
      for (const email of pc.sender_emails) {
        if (typeof email !== 'string') continue
        const trimmedEmail = sanitize(email).toLowerCase()
        if (!trimmedEmail || !isValidEmail(trimmedEmail) || existingSenderEmails.has(trimmedEmail)) continue

        const { error: senderError } = await admin
          .from('authorized_senders')
          .insert({
            fund_id: fundId,
            email: trimmedEmail,
            label: companyName,
          })

        if (!senderError) {
          results.sendersCreated++
          existingSenderEmails.add(trimmedEmail)
        }
      }
    }

    // Get existing metrics for this company to avoid duplicates
    const { data: existingMetrics } = await admin
      .from('metrics')
      .select('id, slug')
      .eq('company_id', companyId)

    const metricBySlug = new Map(
      (existingMetrics ?? []).map(m => [m.slug as string, m.id as string])
    )

    // Create metrics and historical values
    if (Array.isArray(pc.metrics) && pc.metrics.length > 0) {
      const nextOrder = (existingMetrics ?? []).length

      for (let i = 0; i < pc.metrics.length; i++) {
        const m = pc.metrics[i]
        if (!m || typeof m.name !== 'string' || !m.name.trim()) continue

        const metricName = sanitize(m.name)
        if (!metricName) continue

        const slug = slugify(metricName)
        let metricId = metricBySlug.get(slug)

        if (metricId) {
          // Metric already exists — reuse it for values
          results.metricsMatched++
        } else {
          const { data: newMetric, error: metricError } = await admin
            .from('metrics')
            .insert({
              company_id: companyId,
              fund_id: fundId,
              name: metricName,
              slug,
              unit: m.unit ? sanitize(m.unit) : null,
              unit_position: m.unit_position === 'suffix' ? 'suffix' : 'prefix',
              value_type: (['number', 'currency', 'percentage', 'text'] as const).includes(m.value_type as 'number')
                ? m.value_type!
                : 'number',
              reporting_cadence: (['monthly', 'quarterly', 'annual'] as const).includes(m.cadence as 'monthly')
                ? m.cadence!
                : 'monthly',
              display_order: nextOrder + i,
              is_active: true,
            })
            .select('id')
            .single()

          if (metricError || !newMetric) {
            results.errors.push(`Failed to create metric "${metricName}" for "${companyName}": ${metricError?.message}`)
            continue
          }

          metricId = newMetric.id
          results.metricsCreated++
          metricBySlug.set(slug, metricId)
        }

        // Create historical values (upsert — skip if period already exists)
        if (Array.isArray(m.historical_values)) {
          for (const hv of m.historical_values) {
            if (!hv || typeof hv.period !== 'string') continue

            const period = parsePeriodLabel(sanitize(hv.period))
            const valueNum = typeof hv.value === 'number' ? hv.value : parseFloat(String(hv.value).replace(/[^0-9.-]/g, ''))

            // Check if value already exists for this metric + period
            let existingQuery = admin
              .from('metric_values')
              .select('id')
              .eq('metric_id', metricId)
              .eq('period_year', period.year)

            existingQuery = period.quarter != null
              ? existingQuery.eq('period_quarter', period.quarter)
              : existingQuery.is('period_quarter', null)

            existingQuery = period.month != null
              ? existingQuery.eq('period_month', period.month)
              : existingQuery.is('period_month', null)

            const { data: existingVal } = await existingQuery.maybeSingle()

            if (existingVal) {
              results.metricValuesSkipped++
              continue
            }

            const { error: valError } = await admin
              .from('metric_values')
              .insert({
                metric_id: metricId,
                company_id: companyId,
                fund_id: fundId,
                period_label: period.label,
                period_year: period.year,
                period_quarter: period.quarter,
                period_month: period.month,
                value_number: isNaN(valueNum) ? null : valueNum,
                value_text: isNaN(valueNum) ? sanitize(String(hv.value)) : null,
                confidence: 'high',
                is_manually_entered: true,
              })

            if (!valError) results.metricValuesCreated++
          }
        }
      }
    }
  }

  logActivity(admin, fundId, user.id, 'import.data', { companiesCreated: results.companiesCreated, companiesMatched: results.companiesMatched })

  return NextResponse.json(results)
}
