import { NextRequest } from 'next/server'
import { getSeries } from '@/lib/forecast/service'
import { forecastRequest } from '@/lib/forecast/http'

// Monthly/quarterly/annual P&L and cash for a range: actuals alone, a plan alone, or actuals through
// the cutoff followed by the plan. The table, the charts and the export all read this.

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  return forecastRequest(req, 'read', (ctx, vehicle) =>
    getSeries(ctx, {
      vehicle,
      planId: q.get('plan') || undefined,
      versionId: q.get('version') || undefined,
      view: (q.get('view') as any) || undefined,
      start: q.get('start') ?? '',
      end: q.get('end') ?? '',
      interval: (q.get('interval') as any) || undefined,
    }),
  )
}
