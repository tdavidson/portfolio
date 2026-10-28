'use client'

import Link from 'next/link'
import { useAccess } from '@/components/access-context'
import { useVehicleGroups } from '@/components/vehicle-groups'
import { EmptyState } from '@/components/ui/empty-state'
import { groupBySection, isGrouped } from '@/lib/vehicle-groups'
import { VEHICLE_KIND_LABELS, isVehicleKind } from '@/lib/vehicle-kinds'
import { hasSectionForKind, sectionForSlug } from '@/lib/accounting/nav'
import { withCapitalAction, type CapitalAction } from '@/lib/accounting/capital-action'
import { entityBase, entityPagesFor, type IndexEntity } from '@/lib/accounting/entity-pages'

// Every entity, grouped by entity group, each with links to its pages. No figures: this is where
// you pick an entity, and the figures are on its pages. See lib/accounting/entity-index.ts.

const kindLabel = (k: string | null) => (k && isVehicleKind(k) ? VEHICLE_KIND_LABELS[k] : 'Fund')

export function EntityIndex({
  entities,
  section = null,
  action = null,
}: {
  entities: IndexEntity[]
  /** The section the caller arrived for (/funds/journal → `journal`): each name leads there. */
  section?: string | null
  /** Carried onto capital-accounts links — /start sends "issue a capital call" here. */
  action?: CapitalAction | null
}) {
  const access = useAccess()
  const vehicleGroups = useVehicleGroups()
  const canOpen = (domain: Parameters<typeof access>[0], feature?: Parameters<typeof access>[1]) => access(domain, feature) !== 'none'

  const rows = entities
    .map(e => ({ entity: e, pages: entityPagesFor(e.kind, canOpen) }))
    // On a section's landing, only the entities that have that page (an unlisted one, such as
    // opening balances, every entity has).
    .filter(r => !section || hasSectionForKind(section, r.entity.kind ?? 'fund'))

  if (rows.length === 0) {
    return (
      <EmptyState>
        {entities.length === 0
          ? <>No entities yet. Add a fund, SPV, GP entity, individual or management company from <Link href="/funds/status" className="underline underline-offset-4">Admin</Link>.</>
          : 'None of the firm’s entities has this page.'}
      </EmptyState>
    )
  }

  const sectionLabel = section ? sectionForSlug(section)?.label ?? null : null
  const sections = groupBySection(rows, vehicleGroups, r => ({ id: r.entity.id, name: r.entity.name }))
  const grouped = isGrouped(sections, vehicleGroups)

  return (
    <div className="space-y-6">
      {sectionLabel && (
        <p className="text-sm text-muted-foreground">Pick an entity to open its {sectionLabel.toLowerCase()}.</p>
      )}
      {sections.map(sec => (
        <div key={sec.group?.id ?? 'other'} className="space-y-2">
          {grouped && (
            <p className="text-eyebrow uppercase text-muted-foreground">
              {sec.label}<span className="ml-1.5 font-normal normal-case tracking-normal tabular-nums">· {sec.items.length}</span>
              {sec.group && (
                <Link href={`/funds/group/${sec.group.id}`} className="ml-3 font-normal normal-case tracking-normal hover:text-foreground hover:underline">
                  Family page
                </Link>
              )}
            </p>
          )}
          <ul className="rounded-card border divide-y">
            {sec.items.map(({ entity, pages }) => {
              const base = entityBase(entity)
              const link = (slug: string) => withCapitalAction(`${base}/${slug}`, slug === 'capital-accounts' ? action : null)
              return (
                <li key={entity.id ?? entity.name} className="px-4 py-3 flex flex-col gap-2 md:flex-row md:items-baseline md:gap-6">
                  <div className="md:w-64 shrink-0 min-w-0">
                    <Link href={section ? link(section) : base} className="font-medium hover:underline">{entity.name}</Link>
                    <p className="text-xs text-muted-foreground">
                      {kindLabel(entity.kind)}{!entity.active && ' · Inactive'}
                    </p>
                  </div>
                  <nav aria-label={`${entity.name} pages`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    <Link href={base} className="text-muted-foreground hover:text-foreground hover:underline">Overview</Link>
                    {pages.map(p => {
                      const slug = p.href.slice('/funds/'.length)
                      const current = slug === section
                      return (
                        <Link
                          key={p.href}
                          href={link(slug)}
                          className={current ? 'font-medium text-foreground hover:underline' : 'text-muted-foreground hover:text-foreground hover:underline'}
                        >
                          {p.label}
                        </Link>
                      )
                    })}
                  </nav>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
