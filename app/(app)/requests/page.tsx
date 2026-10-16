'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AlertCircle, Check, Loader2, Send, Lock } from 'lucide-react'
import { ResponseTracker } from './response-tracker'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { PortfolioNotesProvider, PortfolioNotesButton, PortfolioNotesPanel } from '@/components/portfolio-notes'
import { useFeatureVisibility } from '@/components/feature-visibility-context'
import type { ResponseStatus } from '@/lib/requests/response-status'
import { lastEndedQuarter } from '@/lib/requests/response-status'
import { isoDate } from '@/lib/reminders/dates'

interface Company {
  id: string
  name: string
  contactEmails: string[]
}

interface Settings {
  isAdmin: boolean
  googleDriveConnected: boolean
  asksEmailProvider: string | null
}

interface QuarterInfo {
  label: string
  year: number
  quarter: number
}

interface CompanyResponse {
  companyId: string
  companyName: string
  quarters: { status: ResponseStatus }[]
}

interface SendResult {
  emails: string
  success: boolean
  error?: string
}

// A starting point, not a fixed template: both fields are editable below, and once a request
// has been sent the last-sent subject and body are restored instead of these. Placeholders
// rather than real names so nothing about a particular fund is baked into the repo.
const DEFAULT_SUBJECT = '[Fund name] - [Period] Information Request'

const DEFAULT_BODY = `Hi! We are finalizing [fund name]'s quarterly and year-end reporting and need your help obtaining the following information:

- [Period] Income Statement (Monthly and Quarterly will be great, if possible)
- [Period] Balance Sheet (Monthly and Quarterly will be great, if possible)
- [Period] Cashflow Statement (Monthly and Quarterly will be great, if possible)
- Any financing activities that occurred during the quarter (If a new financing closed, please include the fully executed documents)
- Any other crucial materials, such as the latest board decks or key KPIs

Please provide the above information by [date]. Contact me or anyone on the team if you have any questions. Thank you,

[Your name]`

function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .split('\n')
    .map(line => {
      if (line.trim().startsWith('- ')) {
        return line
      }
      return line
    })
    .join('<br>\n')
}

/** The four most recently ended quarters, newest first — the ones a request can ask about. */
function recentEndedQuarters(): { year: number; quarter: number; label: string }[] {
  const out: { year: number; quarter: number; label: string }[] = []
  let q = lastEndedQuarter(isoDate(new Date()))
  for (let i = 0; i < 4; i++) {
    out.push({ year: q.year, quarter: q.quarter, label: `Q${q.quarter} ${q.year}` })
    q = lastEndedQuarter(q.endDate.slice(0, 8) + '01')
  }
  return out
}

export default function RequestsPage() {
  const fv = useFeatureVisibility()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [trackerQuarters, setTrackerQuarters] = useState<QuarterInfo[]>([])
  const [trackerData, setTrackerData] = useState<CompanyResponse[]>([])

  const [fromName, setFromName] = useState('')
  const [fromAddress, setFromAddress] = useState('')
  const [subject, setSubject] = useState(DEFAULT_SUBJECT)
  const [bodyText, setBodyText] = useState(DEFAULT_BODY)
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [periodOptions] = useState(recentEndedQuarters)
  const [periodIdx, setPeriodIdx] = useState(0)
  const [dueDate, setDueDate] = useState('')
  const period = periodOptions[periodIdx]
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmSend, setConfirmSend] = useState(false)

  const [testEmail, setTestEmail] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)

  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<{ sent: number; failed: number; details: SendResult[]; warning?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [settingsRes, companiesRes, requestsRes, responsesRes] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/companies'),
      fetch('/api/requests'),
      fetch('/api/requests/responses'),
    ])

    if (settingsRes.ok) {
      const data = await settingsRes.json()
      setSettings({ isAdmin: data.isAdmin, googleDriveConnected: data.googleDriveConnected, asksEmailProvider: data.asksEmailProvider })
    }

    if (companiesRes.ok) {
      const data = await companiesRes.json()
      const withEmail = data
        .filter((c: Record<string, unknown>) => {
          const emails = c.contactEmail as string[] | null
          return emails && emails.length > 0 && c.status === 'active'
        })
        .map((c: Record<string, unknown>) => ({
          id: c.id as string,
          name: c.name as string,
          contactEmails: c.contactEmail as string[],
        }))
      setCompanies(withEmail)
    }

    if (requestsRes.ok) {
      const requests = await requestsRes.json()
      const lastSent = requests.find((r: Record<string, unknown>) => r.status === 'sent')
      if (lastSent) {
        setBodyText(lastSent.body_html as string)
        if (lastSent.subject) setSubject(lastSent.subject as string)
        // Restored the same way as subject and body: the same people are usually copied
        // every quarter. Empty string when the last send had none, so the field stays blank
        // rather than holding a stale list.
        setCc((lastSent.cc as string | null) ?? '')
        setBcc((lastSent.bcc as string | null) ?? '')
      }
    }

    if (responsesRes.ok) {
      const data = await responsesRes.json()
      setTrackerQuarters(data.quarters ?? [])
      setTrackerData(data.data ?? [])
    }

    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleResponseStatusChange = useCallback(async (companyId: string, quarter: number, year: number, status: ResponseStatus) => {
    // Optimistic update
    setTrackerData(prev => prev.map(row => {
      if (row.companyId !== companyId) return row
      return {
        ...row,
        quarters: row.quarters.map((cell, i) => {
          const q = trackerQuarters[i]
          if (q?.quarter === quarter && q?.year === year) return { status }
          return cell
        }),
      }
    }))

    await fetch('/api/requests/responses', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, quarter, year, status }),
    })
  }, [trackerQuarters])

  const toggleCompany = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === companies.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(companies.map((c) => c.id)))
    }
  }

  const handleTestSend = async () => {
    if (!testEmail.trim()) return
    setTestResult(null)
    setTestSending(true)

    const res = await fetch('/api/requests/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject,
        body_html: plainTextToHtml(bodyText),
        body_text: bodyText,
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        from_name: fromName.trim() || undefined,
        from_address: fromAddress.trim() || undefined,
        recipients: [{ emails: [testEmail.trim()], companyName: 'Test' }],
      }),
    })

    setTestSending(false)

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setTestResult({ success: false, error: data.error || 'Failed to send' })
      return
    }

    const data = await res.json()
    if (data.sent > 0) {
      setTestResult({ success: true })
    } else {
      const detail = data.results?.[0]?.error
      setTestResult({ success: false, error: detail || 'Failed to send' })
    }
  }

  const handleSend = async () => {
    setError(null)
    setResults(null)
    setSending(true)

    const recipients = companies
      .filter((c) => selected.has(c.id))
      .map((c) => ({ emails: c.contactEmails, companyName: c.name }))

    const res = await fetch('/api/requests/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject,
        body_html: plainTextToHtml(bodyText),
        body_text: bodyText,
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        from_name: fromName.trim() || undefined,
        from_address: fromAddress.trim() || undefined,
        recipients,
        quarter: period.quarter,
        year: period.year,
        quarter_label: period.label,
        due_date: dueDate || undefined,
      }),
    })

    setSending(false)

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to send')
      return
    }

    const data = await res.json()
    setResults({ sent: data.sent, failed: data.failed, details: data.results, warning: data.warning })
  }

  if (loading) {
    return (
      <PortfolioNotesProvider pageContext="asks">
      <div className="p-4 md:p-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">{fv.asks === 'admin' && <Lock className="h-4 w-4 text-warning" />}Asks</h1>
            <p className="text-sm text-muted-foreground mt-1">Monitor responses to quarterly reporting asks</p>
          </div>
          <div className="flex items-center gap-2">
            <PortfolioNotesButton />
            <AnalystToggleButton />
          </div>
        </div>
        <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 max-w-3xl w-full">
          <div className="animate-pulse space-y-4">
            {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted rounded-lg" />)}
          </div>
        </div>
        <PortfolioNotesPanel />
        <AnalystPanel />
        </div>
      </div>
      </PortfolioNotesProvider>
    )
  }

  if (!settings?.isAdmin) {
    return (
      <PortfolioNotesProvider pageContext="asks">
      <div className="p-4 md:p-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">{fv.asks === 'admin' && <Lock className="h-4 w-4 text-warning" />}Asks</h1>
            <p className="text-sm text-muted-foreground mt-1">Quarterly reporting email program</p>
          </div>
          <div className="flex items-center gap-2">
            <PortfolioNotesButton />
            <AnalystToggleButton />
          </div>
        </div>
        <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 max-w-3xl w-full space-y-6">
          {trackerQuarters.length > 0 && (
            <ResponseTracker quarters={trackerQuarters} data={trackerData} onStatusChange={handleResponseStatusChange} />
          )}
          <div className="rounded-card border border-dashed p-12 text-center space-y-2">
            <p className="text-muted-foreground">
              Administrators can configure and send quarterly reporting request emails to portfolio companies from this page.
            </p>
            <p className="text-xs text-muted-foreground">
              Contact your fund admin to set up or manage the email program.
            </p>
          </div>
        </div>
        <PortfolioNotesPanel />
        <AnalystPanel />
        </div>
      </div>
      </PortfolioNotesProvider>
    )
  }

  const hasEmailProvider = !!settings?.asksEmailProvider

  return (
    <PortfolioNotesProvider pageContext="asks">
    <div className="p-4 md:p-8">
      <div className="mb-6 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">{fv.asks === 'admin' && <Lock className="h-4 w-4 text-warning" />}Asks</h1>
          <div className="flex items-center gap-2">
            <PortfolioNotesButton />
            <AnalystToggleButton />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Monitor responses to quarterly reporting asks</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 max-w-3xl w-full space-y-6">
      {trackerQuarters.length > 0 && (
        <ResponseTracker quarters={trackerQuarters} data={trackerData} onStatusChange={handleResponseStatusChange} />
      )}

      <h2 className="text-lg font-semibold tracking-tight">Create an Ask</h2>

      {!hasEmailProvider && (
        <div className="rounded-card border border-dashed p-4 text-center space-y-1">
          <p className="text-sm text-muted-foreground">Set up an outbound email provider in Settings to enable sending emails.</p>
          <p className="text-xs text-muted-foreground">
            Choose from Gmail, Resend, or Postmark in Settings &gt; Outbound Email.
          </p>
        </div>
      )}

      {/* Compose */}
      <div className="rounded-card border bg-card p-5 space-y-3">
        {settings?.asksEmailProvider && settings.asksEmailProvider !== 'gmail' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>From name</Label>
              <Input
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder="e.g. Acme Ventures"
              />
            </div>
            <div>
              <Label>From address</Label>
              <Input
                type="email"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                placeholder="asks@yourdomain.com"
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="request-period">Reporting period</Label>
            <select
              id="request-period"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={periodIdx}
              onChange={(e) => setPeriodIdx(Number(e.target.value))}
            >
              {periodOptions.map((p, i) => (
                <option key={p.label} value={i}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="request-due">Responses due</Label>
            <Input id="request-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">
              Optional. With a date set, operational reminders chase companies that haven&apos;t responded.
            </p>
          </div>
        </div>

        <div>
          <Label>Subject</Label>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Q4 2025 Portfolio Update Request"
          />
        </div>

        <div>
          <Label>Email body</Label>
          <textarea
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring leading-relaxed"
            rows={14}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder="Hi! Please send us your quarterly update..."
          />
          <p className="text-xs text-muted-foreground mt-1">
            Plain text email body. Line breaks and formatting will be preserved. Pre-populated from your last sent request.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>CC</Label>
            <Input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="cc@example.com, someone@example.com"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Optional. Separate multiple addresses with commas. CC'd on every email sent, and
              visible to recipients.
            </p>
          </div>
          <div>
            <Label>BCC</Label>
            <Input
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
              placeholder="bcc@example.com, someone@example.com"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Optional. Separate multiple addresses with commas. Blind-copied on every email
              sent — recipients don't see them.
            </p>
          </div>
        </div>
      </div>

      {/* Recipients */}
      <div className="rounded-card border bg-card p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-medium">Recipients ({selected.size} of {companies.length})</h2>
          <button
            onClick={toggleAll}
            className="text-xs text-primary hover:underline"
          >
            {selected.size === companies.length ? 'Deselect all' : 'Select all'}
          </button>
        </div>

        {companies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No companies with contact emails found. Add contact emails to your companies first.
          </p>
        ) : (
          <div className="border rounded-lg divide-y max-h-[400px] overflow-y-auto">
            {companies.map((c) => (
              <label
                key={c.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-accent/50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggleCompany(c.id)}
                  className="rounded border-input"
                />
                <span className="text-sm font-medium flex-1">{c.name}</span>
                <span className="text-xs text-muted-foreground text-right">
                  {c.contactEmails.join(', ')}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Test send */}
      <div className="rounded-card border bg-card p-5 space-y-3">
        <h2 className="text-base font-medium">Test send</h2>
        <div className="flex items-center gap-2">
          <Input
            value={testEmail}
            onChange={(e) => { setTestEmail(e.target.value); setTestResult(null) }}
            placeholder="your-email@example.com"
            className="max-w-xs"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestSend}
            disabled={testSending || !testEmail.trim() || !subject.trim() || !bodyText.trim() || !hasEmailProvider}
          >
            {testSending ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Sending...</>
            ) : (
              'Send test'
            )}
          </Button>
          {testResult && (
            testResult.success ? (
              <span className="text-xs text-success flex items-center gap-1">
                <Check className="h-3 w-3" /> Sent
              </span>
            ) : (
              <span className="text-sm text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> {testResult.error || 'Failed'}
              </span>
            )
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Send a test email to yourself before sending to all recipients.
        </p>
      </div>

      {/* Send */}
      <div className="flex items-center gap-3">
        {!confirmSend ? (
          <Button
            onClick={() => setConfirmSend(true)}
            disabled={sending || !subject.trim() || !bodyText.trim() || selected.size === 0 || !hasEmailProvider}
          >
            <Send className="h-4 w-4 mr-1.5" /> Send to {selected.size} recipient{selected.size !== 1 ? 's' : ''}
          </Button>
        ) : (
          <>
            <Button
              variant="destructive"
              onClick={() => { setConfirmSend(false); handleSend() }}
              disabled={sending}
            >
              {sending ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Sending...</>
              ) : (
                <>Confirm, send {selected.size} email{selected.size !== 1 ? 's' : ''} now</>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => setConfirmSend(false)}
              disabled={sending}
            >
              Cancel
            </Button>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-card border border-destructive/30 p-4">
          <p className="text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </p>
        </div>
      )}

      {results && (
        <div className="rounded-card border bg-card p-5 space-y-3">
          <h2 className="text-base font-medium">
            Results: <span className="tabular-nums">{results.sent}</span> sent, <span className="tabular-nums">{results.failed}</span> failed
          </h2>
          {results.warning && (
            <p className="text-sm text-warning flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" /> {results.warning}
            </p>
          )}
          <div className="border rounded-lg divide-y max-h-[300px] overflow-y-auto">
            {results.details.map((r, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2">
                <span className="text-sm">{r.emails}</span>
                {r.success ? (
                  <span className="text-xs text-success flex items-center gap-1">
                    <Check className="h-3 w-3" /> Sent
                  </span>
                ) : (
                  <span className="text-sm text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> {r.error || 'Failed'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
    <PortfolioNotesPanel />
    <AnalystPanel />
    </div>
    </div>
    </PortfolioNotesProvider>
  )
}
