/** Match the single-metric history endpoint: latest capture wins within each reporting period.
 * Include metric_id in the key so this also works for a batch of independent series.
 */
export function dedupeMetricValues<T extends {
  metric_id: string; period_year: number; period_quarter: number | null
  period_month: number | null; created_at: string | null
}>(rows: T[]): T[] {
  const seen = new Map<string, T>()
  for (const row of rows) {
    const key = `${row.metric_id}-${row.period_year}-${row.period_quarter ?? ''}-${row.period_month ?? ''}`
    const existing = seen.get(key)
    if (!existing || (row.created_at ?? '') > (existing.created_at ?? '')) seen.set(key, row)
  }
  return Array.from(seen.values())
}
