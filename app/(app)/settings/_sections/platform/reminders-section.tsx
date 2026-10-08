'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Check, Loader2 } from 'lucide-react'
import { Section } from '@/components/settings/section'

interface ReminderSettings {
  enabled: boolean
  recipients: string[]
  asksSendOffsetDays: number
  adminEmails: string[]
  scopedRecipients?: string[]
}

export function RemindersSection() {
  const [loaded, setLoaded] = useState<ReminderSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [recipients, setRecipients] = useState('')
  const [offset, setOffset] = useState('0')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/reminders')
      .then(r => (r.ok ? r.json() : null))
      .then((s: ReminderSettings | null) => {
        if (!s) return
        setLoaded(s)
        setEnabled(s.enabled)
        setRecipients(s.recipients.join(', '))
        setOffset(String(s.asksSendOffsetDays))
      })
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    const res = await fetch('/api/settings/reminders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, recipients, asksSendOffsetDays: Number(offset) }),
    })
    setSaving(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to save')
      return
    }
    const body = await res.json().catch(() => ({}))
    if (Array.isArray(body.scopedRecipients)) setLoaded(l => (l ? { ...l, scopedRecipients: body.scopedRecipients } : l))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const sendTest = async () => {
    setTesting(true)
    setTestResult(null)
    const res = await fetch('/api/settings/reminders/test', { method: 'POST' })
    setTesting(false)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) setTestResult(data.error || 'Failed to send')
    else if (data.error) setTestResult(data.error)
    else if (!data.sent) setTestResult('Nothing is due right now, so there was nothing to send.')
    else setTestResult(`Sent a digest with ${data.items} item${data.items === 1 ? '' : 's'}.`)
  }

  if (!loaded) return null

  return (
    <Section title="Operational reminders">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          A daily check emails a digest when a compliance filing is coming up, when it&apos;s time to send
          the quarterly data request, or when companies haven&apos;t responded by its due date.
        </p>

        <div className="flex items-center gap-3">
          <Switch id="reminders-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="reminders-enabled">Send operational reminders</Label>
        </div>

        <div>
          <Label htmlFor="reminder-recipients">Recipients</Label>
          <Input
            id="reminder-recipients"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder={loaded.adminEmails.join(', ') || 'ops@yourfund.com'}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Separate addresses with commas. Can include people outside the app, such as your fund
            administrator. Leave empty to send to all fund admins. The reminder covers every entity.
          </p>
          {(loaded.scopedRecipients ?? []).length > 0 && (
            <p className="text-sm text-warning mt-1">
              {(loaded.scopedRecipients ?? []).join(', ')} can only see some entities, but this reminder
              lists items for all of them.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="asks-offset">Send data requests</Label>
          <div className="flex items-center gap-2">
            <Input
              id="asks-offset"
              type="number"
              min={0}
              max={90}
              className="w-20 tabular-nums"
              value={offset}
              onChange={(e) => setOffset(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">days after quarter end</span>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
            Save
          </Button>
          <Button variant="outline" onClick={sendTest} disabled={testing}>
            {testing && <Loader2 className="h-4 w-4 animate-spin" />}
            Send test digest now
          </Button>
          {testResult && <span className="text-sm text-muted-foreground">{testResult}</span>}
        </div>
      </div>
    </Section>
  )
}
