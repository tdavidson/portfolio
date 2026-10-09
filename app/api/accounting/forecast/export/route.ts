import { NextRequest, NextResponse } from 'next/server'
import { getSeries, getVariance } from '@/lib/forecast/service'
import { forecastRequest } from '@/lib/forecast/http'
import { seriesCsv, varianceCsv } from '@/lib/forecast/export'

// CSV of exactly what the series route (or, with kind=variance, the variance route) returns for the
// same parameters.

const version = (v: string | null, fallback: string | null) => {
  const x = v ?? fallback
  return x === 'draft' || x === null ? null : x
}

const csv = (body: string, name: string) =>
  new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]+/g, '-')}.csv"`,
    },
  })

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  return forecastRequest(req, 'read', async (ctx, vehicle) => {
    if (q.get('kind') === 'variance') {
      const compare = q.get('compare') ?? 'actual'
      const v = await getVariance(ctx, {
        vehicle,
        base: { planId: q.get('base') ?? '', versionId: version(q.get('baseVersion'), 'approved') },
        compare: compare === 'actual' ? 'actual' : { planId: compare, versionId: version(q.get('compareVersion'), 'draft') },
        start: q.get('start') ?? '',
        end: q.get('end') ?? '',
        interval: (q.get('interval') as any) || undefined,
      })
      return csv(varianceCsv(v), `${v.vehicle}-variance-${q.get('start')}-${q.get('end')}`)
    }
    const series = await getSeries(ctx, {
      vehicle,
      planId: q.get('plan') || undefined,
      versionId: q.get('version') || undefined,
      view: (q.get('view') as any) || undefined,
      start: q.get('start') ?? '',
      end: q.get('end') ?? '',
      interval: (q.get('interval') as any) || undefined,
    })
    return csv(seriesCsv(series), `${series.vehicle}-${series.plan?.name ?? 'actuals'}-${q.get('start')}-${q.get('end')}`)
  })
}
