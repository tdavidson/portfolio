// The shape of a reported fund figure and how a letter states it (reported-figures.ts stores them).
// Pure: no server imports, so the letter brief and the pages can use it.

export const REPORTED_METRICS = ['tvpi', 'dpi', 'rvpi', 'irr', 'moic'] as const
export type ReportedMetric = typeof REPORTED_METRICS[number]
export type ReportedBasis = 'net' | 'gross'

export interface ReportedFigure {
  metric: ReportedMetric
  basis: ReportedBasis
  /** A multiple as a ratio (1.16); an IRR as a fraction (0.0473). */
  value: number
  source: string
  as_of: string
  note: string | null
  recorded_at: string | null
}

/** The figure as a letter states it: "1.16x", "4.73%". */
export function formatReportedFigure(f: Pick<ReportedFigure, 'metric' | 'value'>): string {
  if (f.metric === 'irr') return `${(f.value * 100).toFixed(2)}%`
  return `${f.value.toFixed(2)}x`
}

export const REPORTED_LABEL: Record<ReportedMetric, string> = { tvpi: 'TVPI', dpi: 'DPI', rvpi: 'RVPI', irr: 'IRR', moic: 'MOIC' }

