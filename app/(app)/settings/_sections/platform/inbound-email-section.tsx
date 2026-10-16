'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Check, Copy, Loader2 } from 'lucide-react'
import { Section } from '@/components/settings/section'

export function InboundEmailSection({
  provider,
  postmarkAddress,
  postmarkToken,
  resendInboundDomain,
  hasResendWebhookSecret,
  hasResendKey,
  onSaved,
}: {
  provider: string | null
  postmarkAddress: string
  postmarkToken: string
  resendInboundDomain: string
  hasResendWebhookSecret: boolean
  hasResendKey: boolean
  onSaved: () => void
}) {
  const [selectedProvider, setSelectedProvider] = useState(provider || '')
  const [addr, setAddr] = useState(postmarkAddress)
  const [rsDomain, setRsDomain] = useState(resendInboundDomain)
  const [rsSecret, setRsSecret] = useState('')
  const [rsApiKey, setRsApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const defaultBase = typeof window !== 'undefined' ? window.location.origin : ''
  const [baseUrl, setBaseUrl] = useState(defaultBase)

  const postmarkWebhookUrl = `${baseUrl}/api/inbound-email?token=${postmarkToken}`
  const resendWebhookUrl = `${baseUrl}/api/inbound-email/resend`

  const handleSave = async () => {
    setSaving(true)
    const payload: Record<string, unknown> = {
      inboundEmailProvider: selectedProvider || null,
    }
    if (selectedProvider === 'postmark') {
      payload.postmarkInboundAddress = addr?.trim() || null
    }
    if (selectedProvider === 'resend') {
      payload.resendInboundDomain = rsDomain?.trim() || null
      if (rsSecret.trim()) payload.resendWebhookSecret = rsSecret.trim()
      if (rsApiKey.trim()) payload.resendApiKey = rsApiKey.trim()
    }
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    if (res.ok) {
      setSaved(true)
      setRsSecret('')
      setRsApiKey('')
      setTimeout(() => setSaved(false), 2000)
      onSaved()
    }
  }

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const providerChanged = selectedProvider !== (provider || '')
  const hasNewData =
    (selectedProvider === 'postmark' && addr !== postmarkAddress) ||
    (selectedProvider === 'resend' && (rsDomain !== resendInboundDomain || rsSecret.trim() || rsApiKey.trim()))
  const canSave = providerChanged || hasNewData

  return (
    <Section title="Inbound email">
      <p className="text-xs text-muted-foreground mb-3">
        Choose how portfolio companies send reports to your fund.
      </p>
      <div className="space-y-3">
        <div>
          <Label>Provider</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
          >
            <option value="">None (disabled)</option>
            <option value="postmark">Postmark</option>
            <option value="resend">Resend</option>
          </select>
        </div>

        {selectedProvider === 'postmark' && (
          <>
            <div>
              <Label>Postmark inbound address</Label>
              <Input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="abc123@inbound.postmarkapp.com"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Set this in the Postmark dashboard under Inbound. Portfolio companies forward their reports to this address, and Postmark delivers them to your webhook.
              </p>
            </div>
            {postmarkToken && (
              <div>
                <Label>Webhook URL</Label>
                <div className="flex items-center gap-2">
                  <div className="flex flex-1 items-center rounded-md border border-input shadow-sm overflow-hidden">
                    <input
                      className="h-9 w-40 shrink-0 bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://your-app.vercel.app"
                    />
                    <span className="text-xs text-muted-foreground bg-muted px-2 py-2 border-l whitespace-nowrap">/api/inbound-email?token={postmarkToken}</span>
                  </div>
                  <Button onClick={() => copyUrl(postmarkWebhookUrl)} variant="outline" size="icon" className="shrink-0 h-9 w-9">
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Paste this into Postmark&#39;s inbound webhook settings. Edit the base URL for local development (e.g. ngrok).
                </p>
              </div>
            )}
          </>
        )}

        {selectedProvider === 'resend' && (
          <>
            <div>
              <Label>Resend inbound domain</Label>
              <Input
                value={rsDomain}
                onChange={(e) => setRsDomain(e.target.value)}
                placeholder="inbound.yourdomain.com"
              />
              <p className="text-xs text-muted-foreground mt-1">
                The domain with receiving turned on in Resend. Mail to any address on it comes to this fund.
              </p>
            </div>
            <div>
              <Label>Resend API key</Label>
              {hasResendKey && (
                <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                  A key is already saved (shared with outbound email). Enter a new one to replace it.
                </p>
              )}
              <Input
                type="password"
                value={rsApiKey}
                onChange={(e) => setRsApiKey(e.target.value)}
                placeholder={hasResendKey ? '••••••••' : 're_...'}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Needs full access, so the app can read each received email and its attachments.
              </p>
            </div>
            <div>
              <Label>Webhook signing secret</Label>
              {hasResendWebhookSecret && (
                <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                  A signing secret is saved. Enter a new one to replace it.
                </p>
              )}
              <Input
                type="password"
                value={rsSecret}
                onChange={(e) => setRsSecret(e.target.value)}
                placeholder={hasResendWebhookSecret ? '••••••••' : 'whsec_...'}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Shown when you create the webhook in Resend (Webhooks, or the webhook&#39;s details page).
              </p>
            </div>
            <div>
              <Label>Webhook URL</Label>
              <div className="flex items-center gap-2">
                <div className="flex flex-1 items-center rounded-md border border-input shadow-sm overflow-hidden">
                  <input
                    className="h-9 w-40 shrink-0 bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://your-app.vercel.app"
                  />
                  <span className="text-xs text-muted-foreground bg-muted px-2 py-2 border-l whitespace-nowrap">/api/inbound-email/resend</span>
                </div>
                <Button onClick={() => copyUrl(resendWebhookUrl)} variant="outline" size="icon" className="shrink-0 h-9 w-9">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                In Resend, add a webhook for the <strong>email.received</strong> event pointing at this URL. Edit the base URL for local development (e.g. ngrok).
              </p>
            </div>
          </>
        )}

        <Button onClick={handleSave} disabled={saving || !canSave} size="sm">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : 'Save'}
        </Button>
      </div>
    </Section>
  )
}
