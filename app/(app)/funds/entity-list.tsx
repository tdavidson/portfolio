import { getUser } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { canSeeVehicle } from '@/lib/access/scope'
import { listIndexEntities } from '@/lib/accounting/entity-index'
import type { CapitalAction } from '@/lib/accounting/capital-action'
import { EntityIndex } from '@/components/accounting/entity-index'

/**
 * The entity index, loaded on the server and rendered in the same response: the registry rows
 * the caller may see, and nothing from anyone's books. The caller has already passed
 * `requireAccountingAccess`, whose access lookup is request-memoised, so this repeats no round trip.
 */
export async function EntityList({ section = null, action = null }: { section?: string | null; action?: CapitalAction | null }) {
  const user = await getUser()
  const page = user ? await resolvePageAccess(user.id) : null
  if (!page) return null

  const entities = await listIndexEntities(createAdminClient() as any, page.fundId, {
    includeManco: canViewPage(page, 'management_company'),
    visible: id => canSeeVehicle(page.access, id),
  })
  return <EntityIndex entities={entities} section={section} action={action} />
}
