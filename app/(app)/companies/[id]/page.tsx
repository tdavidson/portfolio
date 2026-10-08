import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { createClient, getUser } from '@/lib/supabase/server'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'

export async function generateMetadata(props: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const params = await props.params;
  const supabase = await createClient()
  // Runs BEFORE the page body, so it needs the same gate: the title is a company name, and a
  // member without `portfolio` would otherwise read it off the browser tab on their way to being
  // redirected. Falls back to the generic title rather than 404ing — metadata is not the place to
  // decide whether the page exists.
  const { data: { user } } = await supabase.auth.getUser()
  const page = user ? await resolvePageAccess(user.id) : null
  if (!page || !canViewPage(page, 'portfolio')) return { title: 'Company' }

  const { data } = await supabase.from('companies').select('name').eq('id', params.id).maybeSingle() as { data: { name: string } | null }
  return { title: data?.name ?? 'Company' }
}
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCompanyPage } from './load'
import { CompanyPageView } from './page-view'

export default async function CompanyDetailPage(
  props: {
    params: Promise<{ id: string }>
    searchParams: Promise<{ entity?: string | string[] }>
  }
) {
  const params = await props.params;
  const sp = await props.searchParams
  const supabase = await createClient()
  const user = await getUser()
  if (!user) redirect('/auth')
  const admin = createAdminClient()

  // The company itself is `portfolio`. The per-panel checks further down decide which SECTIONS
  // render (notes, interactions, investments each answer to their own domain) — but they were
  // doing that on a page anyone in the fund could open, so a member denied portfolio still got the
  // company and its metrics. The page needs its own gate before any of that.
  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'portfolio')) redirect('/dashboard')

  const data = await loadCompanyPage({ supabase, admin, user, page }, params)
  // Not one of the viewer's companies (or no such company): the same neutral page either way.
  if (!data) notFound()
  // `?entity=<vehicleId>` (holdingHref) opens the page on one entity's register. Only an entity the
  // viewer can see is honoured — `initialEntity` checks it against `data.entities`, which
  // holdingEntities already scoped to the caller's grants.
  const entity = typeof sp.entity === 'string' ? sp.entity : null
  return <CompanyPageView {...data} initialEntityId={entity} />
}
