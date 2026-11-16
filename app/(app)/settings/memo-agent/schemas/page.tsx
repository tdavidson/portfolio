import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { createClient, getUser } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { ensureDefaults, getActiveSchemas } from '@/lib/memo-agent/firm-schemas'
import { SCHEMA_NAMES, type SchemaName } from '@/lib/memo-agent/validate'

export const metadata: Metadata = { title: 'Diligence schemas' }

const SCHEMA_LABELS: Record<SchemaName, { label: string; description: string }> = {
  rubric: { label: 'Rubric', description: 'Scoring dimensions, scale, criteria' },
  qa_library: { label: 'Q&A Library', description: 'Partner Q&A pool, categories, skip logic, references to rubric dimensions' },
  data_room_ingestion: { label: 'Data Room Ingestion', description: 'Per-document extraction, claims, gap analysis' },
  research_dossier: { label: 'Research Dossier', description: 'External research, source quality tiers, founder constraints' },
  memo_output: { label: 'Memo Output', description: 'Memo assembly, sections, paragraph-level provenance, partner-only fields' },
  style_anchors: { label: 'Style anchors', description: 'Metadata for uploaded reference memos, voice and structure aggregation rules' },
  instructions: { label: 'Instructions', description: 'Operating manual, hard rules, six-stage flow, behavioral defaults' },
}

export default async function SchemasIndexPage() {
  const supabase = await createClient()
  const user = await getUser()
  if (!user) redirect('/auth')

  const admin = createAdminClient()
  // These pages configure the diligence agent and render its schemas server-side, so the domain
  // has to be checked here — the middleware only sees the API calls the editors make later.
  // Member-level, not admin-only: the fund decides who gets diligence, and the grant decides who
  // gets to tune it.
  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'diligence')) redirect('/dashboard')

  await ensureDefaults(page.fundId, admin)
  const schemas = await getActiveSchemas(page.fundId, admin)

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4 max-w-4xl">
      <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to settings
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Diligence schemas</h1>
      <p className="text-sm text-muted-foreground mb-6 max-w-2xl">
        These seven YAML/MD files configure how the agent screens deals, runs research, asks Q&amp;A,
        scores per your rubric, and assembles memos. Edit any schema, validate inline, save versions,
        and roll back. Changes apply on the next agent run.
      </p>

      <div className="rounded-md border bg-card divide-y">
        {SCHEMA_NAMES.map(name => {
          const meta = SCHEMA_LABELS[name]
          const row = schemas[name]
          return (
            <Link
              key={name}
              href={`/settings/memo-agent/schemas/${name}`}
              className="block p-4 hover:bg-muted/30"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{meta.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{meta.description}</div>
                </div>
                <div className="text-right text-xs text-muted-foreground shrink-0">
                  {row ? (
                    <>
                      <div className="font-mono">{row.schema_version}</div>
                      <div>{new Date(row.edited_at).toLocaleDateString()}</div>
                    </>
                  ) : (
                    <span className="italic">not yet seeded</span>
                  )}
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
