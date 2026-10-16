// The AI import of a portfolio from a pasted spreadsheet or CSV: the SERVER's model reads the rows
// into companies, their details and their metrics' history. Shared by the web import
// (app/api/import POST), which then writes what it read, and `portfolio_import_preview` from chat,
// which returns it as a proposal and writes nothing (the assistant applies it with the write tools).

import type { SupabaseClient } from '@supabase/supabase-js'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { done, fail, type Outcome } from '@/lib/service-outcome'

export const MAX_IMPORT_TEXT = 500_000

export interface ParsedMetric {
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

export interface ParsedCompany {
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

export interface PortfolioImportParse { companies: ParsedCompany[] }

/** Read pasted rows into companies with the fund's model. Logs the model spend; writes nothing else. */
export async function parsePortfolioImport(
  admin: SupabaseClient,
  fundId: string,
  userId: string,
  text: unknown,
): Promise<Outcome<PortfolioImportParse>> {
  // --- Input validation ---
  if (typeof text !== 'string' || !text.trim()) {
    return fail(400, 'No text provided')
  }

  if (text.length > MAX_IMPORT_TEXT) {
    return fail(400, 'Input too large. Maximum 500KB of text allowed.')
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
    return fail(400, 'Claude API key not configured. Add one in Settings.')
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
      userId,
      provider: aiProviderType,
      model: claudeModel,
      feature: 'import',
      usage: aiResult.usage,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[import] Claude API error:', message)
    return fail(500, 'AI API call failed. Check your API key in Settings.')
  }

  let parsed: PortfolioImportParse
  try {
    // Try to extract JSON from the response (handle possible markdown wrapping)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response')
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return fail(500, 'Failed to parse AI response as JSON. Try importing fewer rows at a time.')
  }

  // --- Structure validation ---
  if (!parsed.companies || !Array.isArray(parsed.companies)) {
    return fail(500, 'Invalid response structure')
  }

  if (parsed.companies.length > 1000) {
    return fail(400, 'Too many companies in parsed result (max 1000)')
  }

  return done(parsed)
}
