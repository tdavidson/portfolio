import { NextRequest } from 'next/server'
import { getVariance } from '@/lib/forecast/service'
import { forecastRequest } from '@/lib/forecast/http'

// Variance of one stream against a plan. `base` is the plan measured against; `baseVersion` is
// 'approved' (default), 'draft', or a version id. `compare` is 'actual' (default) or another plan id,
// with `compareVersion` likewise ('draft' = its live draft).

const version = (v: string | null, fallback: string | null) => {
  const x = v ?? fallback
  return x === 'draft' || x === null ? null : x
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  const compare = q.get('compare') ?? 'actual'
  return forecastRequest(req, 'read', (ctx, vehicle) =>
    getVariance(ctx, {
      vehicle,
      base: { planId: q.get('base') ?? '', versionId: version(q.get('baseVersion'), 'approved') },
      compare: compare === 'actual' ? 'actual' : { planId: compare, versionId: version(q.get('compareVersion'), 'draft') },
      start: q.get('start') ?? '',
      end: q.get('end') ?? '',
      interval: (q.get('interval') as any) || undefined,
    }),
  )
}
