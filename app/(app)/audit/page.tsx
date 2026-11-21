'use client'

import { AuditLogView } from '@/components/audit-log'

/**
 * Audit: what outside firms did in the fund, logged automatically (lib/audit-log). A client page,
 * so it declares nothing in page-domains.ts: the log arrives through /api/audit, gated on the
 * `records` grant under the `audit` switch.
 */
export default function AuditPage() {
  return (
    <div className="p-4 md:p-8">
      <div className="max-w-5xl space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Audit</h1>
        <p className="text-sm text-muted-foreground">
          What each outside firm&apos;s people did in the fund, through the app, an assistant (MCP) or the API: every change and every
          day they connected. Logged automatically while Audit is on, and kept after an engagement ends.
        </p>
      </div>
      <div className="mt-6 max-w-5xl">
        <AuditLogView />
      </div>
    </div>
  )
}
