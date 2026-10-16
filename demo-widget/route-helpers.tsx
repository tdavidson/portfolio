import type { ReactNode } from 'react'
import { fallbackPageData } from './fallbacks'
import type { DemoPages, DemoSnapshot } from './types'
import type { DashboardPageData } from '@/app/(app)/dashboard/load'

/** What a route's render function is handed. */
export interface RouteContext {
  /** The path, without query. */
  pathname: string
  /** The path as the data files key it (same as pathname today). */
  href: string
  pattern: string
  params: Record<string, string>
  query: URLSearchParams
  snapshot: DemoSnapshot
  pages: DemoPages
}

export type RouteRender = (ctx: RouteContext) => ReactNode

/** The page's loaded data, from pages.json or the snapshot fallback; null shows the notice. */
export function pageData<T>(ctx: RouteContext): T | null {
  const recorded = ctx.pages.pages[ctx.href]
  if (recorded !== undefined) {
    // Old recordings predate server-provided card values. Fill them from the synthetic snapshot
    // rather than reintroducing per-card API requests in the shared product component.
    if (ctx.pattern === '/dashboard' || ctx.pattern === '/') {
      const data = recorded as DashboardPageData
      const metrics = new Map(ctx.snapshot.companies.flatMap(c => c.metrics).map(m => [m.id, m]))
      return { ...data, companies: data.companies.map(c => ({ ...c, activeMetrics: c.activeMetrics.map(m => ({
        ...m, latestValue: m.latestValue === undefined ? metrics.get(m.id)?.values.at(-1)?.number ?? null : m.latestValue,
      })) })) } as T
    }
    return recorded as T
  }
  return fallbackPageData(ctx.pattern, ctx.params, ctx.snapshot) as T | null
}

/** A render that needs the page's loaded data: a server page's view. */
export function withData<T>(render: (data: T, ctx: RouteContext) => ReactNode): RouteRender {
  // eslint-disable-next-line react/display-name -- a route's render function, not a component
  return ctx => {
    const data = pageData<T>(ctx)
    return data ? render(data, ctx) : <NoData href={ctx.href} />
  }
}

export function NoData({ href }: { href: string }) {
  return (
    <div className="p-4 md:p-8">
      <div className="rounded-card border border-dashed p-8 text-center">
        <h1 className="text-base font-medium">Not in this snapshot</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          The demo fund has no data recorded for <span className="font-mono text-xs">{href}</span> yet. In the product this
          page is served from the fund&rsquo;s own records.
        </p>
      </div>
    </div>
  )
}

export interface Vehicle { vehicle: string; vehicleId: string | null; kind: string | null; active: boolean }

/** app/(app)/funds/guard.ts's resolveVehicleParam, against the snapshot's vehicle registry. */
export function resolveVehicle(snapshot: DemoSnapshot, raw: string): Vehicle {
  const v = snapshot.vehicles.find(x => x.id === raw)
  if (v) return { vehicle: v.name, vehicleId: v.id, kind: v.kind, active: true }
  return { vehicle: raw, vehicleId: null, kind: null, active: true }
}
