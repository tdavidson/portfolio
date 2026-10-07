'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PortfolioSheetView } from '@/components/portfolio-sheet'

interface Entity { id: string; name: string; kind: string }

// The portfolio by entity: every holding of one fund or SPV — companies, funds and digital assets —
// or all of the viewer's entities together. A portfolio view, gated on `portfolio` (the sheet API),
// not on accounting: the people who work on the companies need it, and they may not keep the books.
// Client page: it renders no fund data on the server; /api/portfolio/sheet and /api/entities scope
// everything to the viewer's entities.
export default function PortfolioByEntityPage() {
  // useSearchParams needs a Suspense boundary in a client page, or the build refuses it.
  return <Suspense><HoldingsByEntity /></Suspense>
}

function HoldingsByEntity() {
  const router = useRouter()
  const params = useSearchParams()
  const selected = params.get('entity')
  const [entities, setEntities] = useState<Entity[] | null>(null)

  useEffect(() => {
    fetch('/api/entities')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: Entity[]) => setEntities((rows ?? []).filter(e => e.kind !== 'manco')))
      .catch(() => setEntities([]))
  }, [])

  const entity = entities?.find(e => e.id === selected) ?? null
  const pick = (id: string | null) => router.replace(id ? `/portfolio?entity=${id}` : '/portfolio')

  return (
    <div className="p-4 md:py-8 md:px-8 max-w-page w-full space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Holdings by entity</h1>
        <p className="text-sm text-muted-foreground">Every holding of a fund or SPV — companies, funds and digital assets — at cost and fair value.</p>
      </div>

      {entities && entities.length > 1 && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Entity">
          <button
            type="button"
            role="tab"
            aria-selected={!entity}
            onClick={() => pick(null)}
            className={`rounded-lg border px-2.5 py-1 text-sm ${!entity ? 'border-primary/40 bg-primary/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            All
          </button>
          {entities.map(e => (
            <button
              key={e.id}
              type="button"
              role="tab"
              aria-selected={entity?.id === e.id}
              onClick={() => pick(e.id)}
              className={`rounded-lg border px-2.5 py-1 text-sm ${entity?.id === e.id ? 'border-primary/40 bg-primary/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {e.name}
            </button>
          ))}
        </div>
      )}

      {entities !== null && <PortfolioSheetView key={entity?.name ?? 'all'} group={entity?.name} />}
    </div>
  )
}
