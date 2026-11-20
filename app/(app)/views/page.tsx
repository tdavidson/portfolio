'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { LayoutGrid, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'

interface ViewSummary {
  id: string
  name: string
  description: string | null
  kind: 'mine' | 'shared'
  blocks: number
  updatedAt: string | null
  path: string
}

/**
 * Custom views (lib/custom-views): layouts a member described to an assistant and saved. A client
 * page, so it declares nothing in page-domains.ts: the list comes from /api/views, and each view's
 * figures from /api/views/[id], which checks every block against the viewer's access.
 */
export default function ViewsPage() {
  const [views, setViews] = useState<ViewSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/views')
      .then(async r => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error ?? 'Could not load views.')
        setViews(body.views ?? [])
      })
      .catch(e => setError((e as Error).message))
  }, [])

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-4xl space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Views</h1>
          <Button asChild size="sm" variant="outline" className="text-muted-foreground"><Link href="/views/new"><Plus /> New view</Link></Button>
        </div>
        <p className="text-sm text-muted-foreground">Build custom views of your portfolio, fund, and limited partner data.</p>
      </div>
      <div className="mt-6 max-w-4xl">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : views === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading views</div>
        ) : views.length === 0 ? (
          <EmptyState icon={LayoutGrid} action={<Button asChild variant="outline" className="text-muted-foreground"><Link href="/views/new"><Plus /> New view</Link></Button>}>
            No views yet. Describe the first one and see it built on your live data.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {views.map(v => (
              <li key={v.id}>
                <Link href={v.path} className="block rounded-card border bg-card p-4 transition-colors hover:bg-accent">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{v.name}</p>
                    {v.kind === 'shared' && <Badge variant="outline">Shared</Badge>}
                  </div>
                  {v.description && <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{v.description}</p>}
                  <p className="mt-2 text-caption text-muted-foreground">
                    {v.blocks} {v.blocks === 1 ? 'block' : 'blocks'}
                    {v.updatedAt ? ` · updated ${new Date(v.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
