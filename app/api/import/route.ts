import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { parsePortfolioImport } from '@/lib/portfolio/ai-import'
import { logActivity } from '@/lib/activity'
import { rateLimit } from '@/lib/rate-limit'
import { loadEntityScope } from '@/lib/access/entity-scope'

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

  // The model reads the paste into companies and metrics: lib/portfolio/ai-import.ts, which
  // `portfolio_import_preview` runs from chat too (as a preview that writes nothing).
  const parsedOutcome = await parsePortfolioImport(admin, fundId, user.id, text)
  if (!parsedOutcome.ok) return NextResponse.json({ error: parsedOutcome.error }, { status: parsedOutcome.status })
  const parsed = parsedOutcome.value

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
