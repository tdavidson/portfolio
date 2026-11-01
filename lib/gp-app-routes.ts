/**
 * The first path segments of the GP app: the folders under app/(app). Every page there renders
 * inside app/(app)/layout.tsx, which resolves the caller's fund membership anyway, so proxy.ts
 * leaves the LP/GP split for these paths to the layout instead of reading fund_members and
 * lp_accounts itself on every navigation. lib/gp-app-routes.test.ts keeps this list in step with
 * the folders.
 */
export const GP_APP_SEGMENTS: ReadonlySet<string> = new Set([
  'accounting',
  'companies',
  'company-updates',
  'compliance',
  'dashboard',
  'deals',
  'diligence',
  'emails',
  'entities',
  'funds',
  'getting-started',
  'import',
  'interactions',
  'investments',
  'letters',
  'lp-activity',
  'lp-portal',
  'lps',
  'manco',
  'notes',
  'pending-actions',
  'records',
  'requests',
  'review',
  'settings',
  'start',
  'support',
  'updates',
  'usage',
])

export function isGpAppPath(pathname: string): boolean {
  return GP_APP_SEGMENTS.has(pathname.split('/')[1] ?? '')
}
