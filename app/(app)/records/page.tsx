import { redirect } from 'next/navigation'

/** Records became Audit (lib/audit-log). Old links land there. */
export default function RecordsPage() {
  redirect('/audit')
}
