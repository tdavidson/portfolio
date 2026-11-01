'use client'

// The fund's switch for linked sign-ins (lib/account-links.ts), and who has linked. Admin only.

import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'

export function LinkedSignInsPolicy() {
  const [allow, setAllow] = useState<boolean | null>(null)
  const [linked, setLinked] = useState<{ userId: string; email: string | null }[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/linked-sign-ins').then(r => (r.ok ? r.json() : null)).then(d => {
      if (!d) return
      setAllow(d.allow !== false)
      setLinked(Array.isArray(d.linked) ? d.linked : [])
    }).catch(() => {})
  }, [])

  async function change(next: boolean) {
    setAllow(next); setError(null)
    const res = await fetch('/api/settings/linked-sign-ins', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow: next }) })
    if (!res.ok) { setAllow(!next); setError('That did not save.') }
  }

  if (allow === null) return null
  return (
    <div className="mt-6 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Linked sign-ins</h3>
          <p className="text-sm text-muted-foreground">
            Lets people who also work for other funds here (an outside administrator, say) reach this fund through one assistant
            connection. They can still do only what their access here allows.
          </p>
        </div>
        <Switch checked={allow} onCheckedChange={change} aria-label="Allow linked sign-ins" />
      </div>
      {linked.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Linked: {linked.map(l => l.email ?? 'unknown').join(', ')}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
