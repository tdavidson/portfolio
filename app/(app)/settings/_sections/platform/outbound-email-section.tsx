'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Section } from '@/components/settings/section'
import { GoogleConnectionUI } from './google-drive-section'

export function OutboundEmailSection({
  provider,
  asksProvider,
  approvalEmailSubject: savedApprovalSubject,
  approvalEmailBody: savedApprovalBody,
  systemEmailFromName: savedFromName,
  systemEmailFromAddress: savedFromAddress,
  hasResendKey,
  hasPostmarkServerToken,
  googleConnected,
  hasGoogleCredentials,
  googleClientId,
  onSaved,
}: {
  provider: string | null
  asksProvider: string | null
  approvalEmailSubject: string | null
  approvalEmailBody: string | null
  systemEmailFromName: string | null
  systemEmailFromAddress: string | null
  hasResendKey: boolean
  hasPostmarkServerToken: boolean
  googleConnected: boolean
  hasGoogleCredentials: boolean
  googleClientId: string
  onSaved: () => void
}) {
  const defaultSubject = "You've been approved to join {{fundName}}"
  const defaultBody = `<h2>Congrats!</h2>\n<p>You've been approved to join <strong>{{fundName}}</strong>.</p>\n<p><a href="{{siteUrl}}/auth">Sign in to get started</a></p>`

  const [systemProvider, setSystemProvider] = useState(provider || '')
  const [selectedAsksProvider, setSelectedAsksProvider] = useState(asksProvider || '')
  const [approvalSubject, setApprovalSubject] = useState(savedApprovalSubject || '')
  const [approvalBody, setApprovalBody] = useState(savedApprovalBody || '')
  const [fromName, setFromName] = useState(savedFromName || '')
  const [fromAddress, setFromAddress] = useState(savedFromAddress || '')
  const [resendKey, setResendKey] = useState('')
  const [postmarkToken, setPostmarkToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showApprovalEmail, setShowApprovalEmail] = useState(false)

  // Determine which providers are actively selected (deduplicated)
  const activeProviders = new Set<string>()
  if (systemProvider) activeProviders.add(systemProvider)
  if (selectedAsksProvider) activeProviders.add(selectedAsksProvider)

  const handleSave = async () => {
    setSaving(true)
    const payload: Record<string, unknown> = {
      outboundEmailProvider: systemProvider || null,
      asksEmailProvider: selectedAsksProvider || null,
      approvalEmailSubject: approvalSubject.trim() || null,
      approvalEmailBody: approvalBody.trim() || null,
      systemEmailFromName: fromName.trim() || null,
      systemEmailFromAddress: fromAddress.trim() || null,
    }
    if (activeProviders.has('resend') && resendKey.trim()) {
      payload.resendApiKey = resendKey.trim()
    }
    if (activeProviders.has('postmark') && postmarkToken.trim()) {
      payload.postmarkServerToken = postmarkToken.trim()
    }
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    if (res.ok) {
      setSaved(true)
      setResendKey('')
      setPostmarkToken('')
      setTimeout(() => setSaved(false), 2000)
      onSaved()
    }
  }

  const systemProviderChanged = systemProvider !== (provider || '')
  const asksProviderChanged = selectedAsksProvider !== (asksProvider || '')
  const approvalSubjectChanged = (approvalSubject.trim() || null) !== (savedApprovalSubject || null)
  const approvalBodyChanged = (approvalBody.trim() || null) !== (savedApprovalBody || null)
  const fromNameChanged = (fromName.trim() || null) !== (savedFromName || null)
  const fromAddressChanged = (fromAddress.trim() || null) !== (savedFromAddress || null)
  const hasNewSecret = resendKey.trim() || postmarkToken.trim()
  const canSave = systemProviderChanged || asksProviderChanged || approvalSubjectChanged || approvalBodyChanged || fromNameChanged || fromAddressChanged || hasNewSecret

  const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

  return (
    <Section title="Outbound email">
      <p className="text-xs text-muted-foreground mb-3">
        Configure email providers for system notifications and portfolio asks.
      </p>
      <div className="space-y-3">
        <div>
          <Label>System emails</Label>
          <p className="text-xs text-muted-foreground mb-1.5">
            Automated notifications like member approvals.
          </p>
          <select
            className={selectClass}
            value={systemProvider}
            onChange={(e) => setSystemProvider(e.target.value)}
          >
            <option value="">None (disabled)</option>
            <option value="resend">Resend</option>
            <option value="postmark">Postmark</option>
            <option value="gmail">Gmail</option>
          </select>
        </div>

        {systemProvider && (
          <div className="border rounded-card p-3 space-y-3">
            <div>
              <button
                type="button"
                onClick={() => setShowApprovalEmail(!showApprovalEmail)}
                className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground transition-colors"
              >
                {showApprovalEmail ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Member accepted email
              </button>
              <p className="text-xs text-muted-foreground mt-0.5 ml-5">
                Sent when a new member is approved to join the fund.
              </p>
            </div>
            {showApprovalEmail && (
              <>
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
                  <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
                    Must be a verified sender address for your email provider.{systemProvider === 'gmail' ? ' Ignored when using Gmail, emails are sent from your connected Google account.' : ''}
                  </p>
                  <Input
                    type="email"
                    value={fromAddress}
                    onChange={(e) => setFromAddress(e.target.value)}
                    placeholder="notifications@yourdomain.com"
                    disabled={systemProvider === 'gmail'}
                  />
                </div>
                <div>
                  <Label>Subject</Label>
                  <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
                    Use {'{{fundName}}'} as a placeholder.
                  </p>
                  <Input
                    value={approvalSubject}
                    onChange={(e) => setApprovalSubject(e.target.value)}
                    placeholder={defaultSubject}
                  />
                </div>
                <div>
                  <Label>Body</Label>
                  <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
                    HTML body. Use {'{{fundName}}'} and {'{{siteUrl}}'} as placeholders.
                  </p>
                  <Textarea
                    value={approvalBody}
                    onChange={(e) => setApprovalBody(e.target.value)}
                    placeholder={defaultBody}
                    rows={5}
                    className="font-mono text-xs"
                  />
                </div>
              </>
            )}
          </div>
        )}

        <div>
          <Label>Asks emails</Label>
          <p className="text-xs text-muted-foreground mb-1.5">
            Quarterly reporting requests from the Asks page.
          </p>
          <select
            className={selectClass}
            value={selectedAsksProvider}
            onChange={(e) => setSelectedAsksProvider(e.target.value)}
          >
            <option value="">None (disabled)</option>
            <option value="resend">Resend</option>
            <option value="postmark">Postmark</option>
            <option value="gmail">Gmail</option>
          </select>
        </div>

        {activeProviders.size > 0 && (
          <>
            <div className="border-t pt-3">
              <p className="text-sm font-medium">Settings for selected email providers</p>
            </div>
          </>
        )}

        {activeProviders.has('resend') && (
          <div>
            <Label>Resend API key</Label>
            {hasResendKey && (
              <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                A key is already saved. Enter a new one to replace it.
              </p>
            )}
            <Input
              type="password"
              value={resendKey}
              onChange={(e) => setResendKey(e.target.value)}
              placeholder={hasResendKey ? '••••••••' : 're_...'}
            />
          </div>
        )}

        {activeProviders.has('postmark') && (
          <div>
            <Label>Postmark server token</Label>
            {hasPostmarkServerToken && (
              <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                A token is already saved. Enter a new one to replace it.
              </p>
            )}
            <Input
              type="password"
              value={postmarkToken}
              onChange={(e) => setPostmarkToken(e.target.value)}
              placeholder={hasPostmarkServerToken ? '••••••••' : 'Server token'}
            />
          </div>
        )}

        {activeProviders.has('gmail') && (
          <div className="space-y-2">
            <Label>Gmail connection</Label>
            <p className="text-xs text-muted-foreground">
              Emails will be sent from your connected Google account. The same Google connection is used for Gmail and Google Drive.
            </p>
            <GoogleConnectionUI
              connected={googleConnected}
              hasCredentials={hasGoogleCredentials}
              clientId={googleClientId}
              onChanged={onSaved}
            />
          </div>
        )}

        <Button onClick={handleSave} disabled={saving || !canSave} size="sm">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : 'Save'}
        </Button>
      </div>
    </Section>
  )
}
