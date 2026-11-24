// Which background workers the scheduled tick should start. Every feature these serve is optional,
// so each worker runs only when its feature is in use AND there is something for it to do. One
// cheap `limit 1` read per worker decides it; a worker with nothing to do is never invoked.
//
// Queued work (memo jobs, OCR, deal research, backfills) is normally started the moment it is
// queued (lib/cron/kick.ts). The tick is the safety net for a kick that was lost, plus the jobs
// that are genuinely periodic (reminders, the weekly digest, access expiry, Affinity sync).

import type { CronWorker } from './kick'

type Admin = { from: (table: string) => any }

/** `queues` = only the queue safety nets: safe to run as often as a host allows. */
export type TickScope = 'all' | 'queues'

interface Gate {
  worker: CronWorker
  /** Periodic jobs that must run at most once a day are left out of the `queues` scope. */
  daily: boolean
  /** True when the worker has work. A failed read (e.g. a table from a migration not yet applied) counts as no work. */
  due: (admin: Admin, now: Date) => Promise<boolean>
}

async function exists(query: PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<boolean> {
  try {
    const { data, error } = await query
    return !error && (data ?? []).length > 0
  } catch {
    return false
  }
}

export const GATES: Gate[] = [
  {
    // Pending jobs, and running ones so the worker's stale-job reaper still runs.
    worker: 'memo-agent-worker',
    daily: false,
    due: admin => exists(admin.from('memo_agent_jobs').select('id').in('status', ['pending', 'running']).limit(1)),
  },
  {
    worker: 'company-updates-ocr',
    daily: false,
    due: admin => exists(admin.from('company_update_artifacts').select('id').eq('ocr_status', 'pending').lt('ocr_attempts', 3).limit(1)),
  },
  {
    worker: 'entity-documents-ocr',
    daily: false,
    due: admin => exists(admin.from('entity_documents').select('id').eq('ocr_status', 'pending').limit(1)),
  },
  {
    // Running too: the worker resets a deal stranded in 'running' by a killed invocation.
    worker: 'deal-research',
    daily: false,
    due: admin => exists(admin.from('inbound_deals').select('id').in('research_status', ['pending', 'running']).limit(1)),
  },
  {
    worker: 'company-updates-backfill',
    daily: false,
    due: admin => exists(admin.from('company_update_backfill_jobs').select('id').eq('status', 'running').limit(1)),
  },
  {
    // Holding documents and update files stored before their duplicate-check hashes existed.
    worker: 'document-hashes',
    daily: false,
    due: async admin => await exists(admin.from('company_documents').select('id').is('hashed_at', null).limit(1))
      || exists(admin.from('company_update_artifacts').select('id').is('hashed_at', null).limit(1)),
  },
  {
    // Only deals linked to Affinity; the worker itself skips any synced in the last hour.
    worker: 'affinity-sync',
    daily: true,
    due: admin => exists(admin.from('diligence_deals').select('id').eq('deal_status', 'active').not('affinity_organization_id', 'is', null).limit(1)),
  },
  {
    // Access already stops resolving when the date passes; this only removes the membership.
    worker: 'access-expiry',
    daily: true,
    due: (admin, now) => exists(admin.from('fund_members').select('id').not('access_expires_at', 'is', null).lte('access_expires_at', now.toISOString()).neq('role', 'admin').limit(1)),
  },
  {
    worker: 'ops-reminders',
    daily: true,
    due: admin => exists(admin.from('fund_settings').select('fund_id').eq('reminders_enabled', true).limit(1)),
  },
  {
    // Only vehicles whose management fee schedule books its own periods on their due dates, or
    // whose monthly fee spread (a recurring entry) drafts or posts its months.
    worker: 'fee-periods',
    daily: true,
    due: async admin => await exists(admin.from('vehicle_accounting_settings').select('vehicle_id').in('fee_schedule->>postMode', ['draft', 'post']).limit(1))
      || exists(admin.from('accounting_schedules').select('id').eq('active', true).eq('kind', 'management_fee_spread').in('mode', ['draft', 'post']).limit(1)),
  },
  {
    // Only funds with a recurring journal entry that drafts or posts on its own.
    worker: 'recurring-entries',
    daily: true,
    due: admin => exists(admin.from('accounting_schedules').select('id').eq('active', true).eq('kind', 'fixed').in('mode', ['draft', 'post']).limit(1)),
  },
  {
    // Weekly: Mondays (UTC) only, for funds that screen inbound deals.
    worker: 'deals-digest',
    daily: true,
    due: async (admin, now) => now.getUTCDay() === 1
      && exists(admin.from('fund_settings').select('fund_id').eq('deal_intake_enabled', true).limit(1)),
  },
]

/** The workers to start on this tick, in GATES order. */
export async function dueWorkers(admin: Admin, opts: { scope?: TickScope; now?: Date } = {}): Promise<CronWorker[]> {
  const scope = opts.scope ?? 'all'
  const now = opts.now ?? new Date()
  const gates = GATES.filter(g => scope === 'all' || !g.daily)
  const due = await Promise.all(gates.map(g => g.due(admin, now)))
  return gates.filter((_, i) => due[i]).map(g => g.worker)
}
