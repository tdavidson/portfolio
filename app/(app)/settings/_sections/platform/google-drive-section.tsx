'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AlertCircle, Check, ChevronDown, ChevronRight, FolderOpen, Loader2, X } from 'lucide-react'

function GoogleSetupGuide({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  if (!show) {
    return (
      <button onClick={onToggle} className="text-xs text-muted-foreground hover:text-foreground underline">
        Setup guide
      </button>
    )
  }
  return (
    <div className="space-y-1.5">
      <button onClick={onToggle} className="text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1">
        <ChevronDown className="h-3 w-3" /> Setup guide
      </button>
      <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
        <li>Go to{' '}
          <a href="https://console.cloud.google.com" target="_blank" rel="noopener noreferrer" className="underline">Google Cloud Console</a>
        </li>
        <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer" className="underline">Create a project</a> (or select an existing one)</li>
        <li>Configure the{' '}
          <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noopener noreferrer" className="underline">OAuth consent screen</a>
          <ul className="list-disc list-inside ml-3 mt-0.5 space-y-0.5">
            <li>Set User type to <strong>Internal</strong> (avoids 7-day token expiry)</li>
            <li>App name & support email, fill in anything</li>
            <li>Scopes: add <code className="text-[11px] bg-muted px-1 rounded">drive.file</code> and <code className="text-[11px] bg-muted px-1 rounded">gmail.send</code></li>
          </ul>
        </li>
        <li>Enable APIs:{' '}
          <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer" className="underline">Google Drive API</a>,{' '}
          <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer" className="underline">Gmail API</a>
        </li>
        <li><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="underline">Create OAuth credentials</a>
          <ul className="list-disc list-inside ml-3 mt-0.5 space-y-0.5">
            <li>Type: <strong>Web application</strong></li>
            <li>Authorized redirect URI: <code className="text-[11px] bg-muted px-1 rounded">{typeof window !== 'undefined' ? window.location.origin : ''}/api/auth/google/callback</code></li>
          </ul>
        </li>
        <li>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the fields above</li>
      </ol>
    </div>
  )
}

function GoogleCredentialsForm({
  clientId,
  onSave,
  onCancel,
  saving,
}: {
  clientId: string
  onSave: (clientId: string, clientSecret: string) => void
  onCancel?: () => void
  saving: boolean
}) {
  const [newClientId, setNewClientId] = useState(clientId)
  const [newClientSecret, setNewClientSecret] = useState('')
  const [showSetupGuide, setShowSetupGuide] = useState(!clientId)

  useEffect(() => { setNewClientId(clientId) }, [clientId])

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Google OAuth credentials</p>
      <div>
        <Label>Client ID</Label>
        <Input
          value={newClientId}
          onChange={(e) => setNewClientId(e.target.value)}
          placeholder="123456789.apps.googleusercontent.com"
        />
      </div>
      <div>
        <Label>Client secret</Label>
        <Input
          type="password"
          value={newClientSecret}
          onChange={(e) => setNewClientSecret(e.target.value)}
          placeholder="GOCSPX-..."
        />
      </div>
      <GoogleSetupGuide show={showSetupGuide} onToggle={() => setShowSetupGuide(!showSetupGuide)} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave(newClientId, newClientSecret)} disabled={saving || !newClientId.trim() || !newClientSecret.trim()}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save credentials'}
        </Button>
        {onCancel && (
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

export function GoogleConnectionUI({
  connected,
  hasCredentials,
  clientId: existingClientId,
  onChanged,
}: {
  connected: boolean
  hasCredentials: boolean
  clientId: string
  onChanged: () => void
}) {
  const [editingCreds, setEditingCreds] = useState(!hasCredentials)
  const [savingCreds, setSavingCreds] = useState(false)
  const [credsSaved, setCredsSaved] = useState(false)
  const [removingCreds, setRemovingCreds] = useState(false)

  useEffect(() => { if (hasCredentials && editingCreds && credsSaved) setEditingCreds(false) }, [hasCredentials, editingCreds, credsSaved])

  const saveCredentials = async (clientId: string, clientSecret: string) => {
    setSavingCreds(true)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        googleClientId: clientId.trim(),
        googleClientSecret: clientSecret.trim(),
      }),
    })
    setSavingCreds(false)
    if (res.ok) {
      setEditingCreds(false)
      setCredsSaved(true)
      setTimeout(() => setCredsSaved(false), 2000)
      onChanged()
    }
  }

  const removeCredentials = async () => {
    if (!confirm('Remove Google OAuth credentials? This will also disconnect your Google account.')) return
    setRemovingCreds(true)
    // Clear credentials and disconnect
    await Promise.all([
      fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleClientId: '', googleClientSecret: '' }),
      }),
      fetch('/api/settings/drive', { method: 'DELETE' }),
    ])
    setRemovingCreds(false)
    setEditingCreds(true)
    onChanged()
  }

  if (connected) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <Check className="h-4 w-4 text-success shrink-0" />
          <span>Google account connected.</span>
        </div>
        {editingCreds ? (
          <GoogleCredentialsForm
            clientId={existingClientId}
            onSave={saveCredentials}
            onCancel={() => setEditingCreds(false)}
            saving={savingCreds}
          />
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground flex-1">
              Google credentials configured.
              {credsSaved && <span className="text-success ml-1">Saved!</span>}
            </p>
            <Button size="sm" variant="outline" onClick={() => setEditingCreds(true)} className="text-xs h-7">
              Update credentials
            </Button>
            <Button size="sm" variant="outline" onClick={() => { window.location.href = '/api/auth/google' }} className="text-xs h-7">
              Reconnect
            </Button>
            <Button size="sm" variant="outline" onClick={removeCredentials} disabled={removingCreds} className="text-sm h-7 text-destructive hover:text-destructive hover:bg-destructive-subtle dark:hover:bg-destructive-subtle/30">
              {removingCreds ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Remove'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {editingCreds || !hasCredentials ? (
        <GoogleCredentialsForm
          clientId={existingClientId}
          onSave={saveCredentials}
          onCancel={hasCredentials ? () => setEditingCreds(false) : undefined}
          saving={savingCreds}
        />
      ) : (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground flex-1">
            Google credentials configured.
            {credsSaved && <span className="text-success ml-1">Saved!</span>}
          </p>
          <Button size="sm" variant="outline" onClick={() => setEditingCreds(true)} className="text-xs h-7">
            Update credentials
          </Button>
          <Button size="sm" variant="outline" onClick={removeCredentials} disabled={removingCreds} className="text-sm h-7 text-destructive hover:text-destructive hover:bg-destructive-subtle dark:hover:bg-destructive-subtle/30">
            {removingCreds ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Remove'}
          </Button>
        </div>
      )}
      {hasCredentials && (
        <Button size="sm" onClick={() => { window.location.href = '/api/auth/google' }}>
          Connect Google account
        </Button>
      )}
    </div>
  )
}

// ──────────────────────────── Google Drive ────────────────────────────

export function GoogleDriveSection({
  fundId,
  connected,
  folderId,
  folderName,
  hasCredentials,
  onChanged,
}: {
  fundId: string
  connected: boolean
  folderId: string | null
  folderName: string | null
  hasCredentials: boolean
  onChanged: () => void
}) {
  const [folderError, setFolderError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([])
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string; shared?: boolean }[]>([{ id: null, name: 'My Drive' }])
  const [saving, setSaving] = useState(false)
  const [browseMode, setBrowseMode] = useState<'my' | 'shared'>('my')
  const [urlInput, setUrlInput] = useState('')

  // Resolve a pasted Drive folder URL directly to the saved folder — skips the
  // browser entirely, which matters for deeply-nested or shared-drive folders
  // ("Shared with me" lists every shared folder flat, unusable on a big drive).
  const selectByUrl = async () => {
    if (!urlInput.trim()) return
    setSaving(true)
    setFolderError(null)
    const res = await fetch('/api/settings/drive/folders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlInput.trim() }),
    })
    if (!res.ok) {
      setSaving(false)
      const data = await res.json().catch(() => ({}))
      setFolderError(data.error || 'Failed to use folder')
      return
    }
    const { folderId, folderName } = await res.json()
    setUrlInput('')
    await selectFolder({ id: folderId, name: folderName })
  }

  const loadFolders = async (parentId?: string, shared?: boolean) => {
    setLoadingFolders(true)
    setFolderError(null)
    try {
      let url = '/api/settings/drive/folders'
      if (shared) {
        url += '?shared=true'
      } else if (parentId) {
        url += `?parent=${parentId}`
      }
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setFolderError(data.error || 'Failed to list folders')
        return
      }
      const data = await res.json()
      setFolders(data.folders ?? [])
    } catch {
      setFolderError('Failed to list folders')
    } finally {
      setLoadingFolders(false)
    }
  }

  const openPicker = () => {
    setShowPicker(true)
    setBrowseMode('my')
    setUrlInput('')
    setBreadcrumbs([{ id: null, name: 'My Drive' }])
    loadFolders()
  }

  const switchToShared = () => {
    setBrowseMode('shared')
    setBreadcrumbs([{ id: null, name: 'Shared with me', shared: true }])
    loadFolders(undefined, true)
  }

  const switchToMyDrive = () => {
    setBrowseMode('my')
    setBreadcrumbs([{ id: null, name: 'My Drive' }])
    loadFolders()
  }

  const navigateInto = (folder: { id: string; name: string }) => {
    setBreadcrumbs(prev => [...prev, { id: folder.id, name: folder.name }])
    loadFolders(folder.id)
  }

  const navigateToBreadcrumb = (index: number) => {
    const crumb = breadcrumbs[index]
    setBreadcrumbs(prev => prev.slice(0, index + 1))
    if (crumb.shared) {
      loadFolders(undefined, true)
    } else {
      loadFolders(crumb.id ?? undefined)
    }
  }

  const selectFolder = async (folder: { id: string; name: string }) => {
    setSaving(true)
    setFolderError(null)
    const res = await fetch('/api/settings/drive', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folder.id, folder_name: folder.name }),
    })
    setSaving(false)
    if (res.ok) {
      setShowPicker(false)
      onChanged()
    } else {
      const data = await res.json().catch(() => ({}))
      setFolderError(data.error || 'Failed to select folder')
    }
  }

  const selectCurrentFolder = async () => {
    const current = breadcrumbs[breadcrumbs.length - 1]
    if (!current.id) {
      // Root — use 'root' as the ID
      setSaving(true)
      setFolderError(null)
      const res = await fetch('/api/settings/drive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: 'root', folder_name: 'My Drive' }),
      })
      setSaving(false)
      if (res.ok) { setShowPicker(false); onChanged() }
      else {
        const data = await res.json().catch(() => ({}))
        setFolderError(data.error || 'Failed to select folder')
      }
    } else {
      await selectFolder({ id: current.id, name: current.name })
    }
  }

  if (!connected) {
    return (
      <div className="space-y-3">
        <p className="text-xs font-medium">Google Drive</p>
        <p className="text-xs text-muted-foreground">
          {hasCredentials
            ? 'Google credentials are configured. Connect your Google account to enable Drive storage.'
            : 'Set up your Google OAuth credentials in the Google section in Email settings, then connect your account to enable Drive storage.'}
        </p>
        {hasCredentials && (
          <Button size="sm" onClick={() => { window.location.href = '/api/auth/google' }}>
            Connect Google account
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium">Google Drive</p>
      <p className="text-xs text-muted-foreground">
        Google Drive is connected. Attachments from processed emails will be saved automatically.
      </p>

      {folderName ? (
        <div className="flex items-center gap-2 text-sm">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span>Saving to: <span className="font-medium">{folderName}</span></span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No folder selected. Pick a folder to start saving reports.
        </p>
      )}

      {showPicker ? (
        <div className="border rounded-card p-3 space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Paste a Google Drive folder URL</label>
            <div className="flex gap-2">
              <Input
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); selectByUrl() } }}
                placeholder="https://drive.google.com/drive/folders/..."
                className="h-8 text-sm"
                disabled={saving}
              />
              <Button size="sm" onClick={selectByUrl} disabled={saving || !urlInput.trim()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Use'}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">or browse</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={switchToMyDrive}
              className={`px-2 py-1 rounded ${browseMode === 'my' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              My Drive
            </button>
            <button
              onClick={switchToShared}
              className={`px-2 py-1 rounded ${browseMode === 'shared' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Shared with me
            </button>
          </div>

          <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3" />}
                <button
                  onClick={() => navigateToBreadcrumb(i)}
                  className={`hover:text-foreground ${i === breadcrumbs.length - 1 ? 'text-foreground font-medium' : ''}`}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>

          <div className="border rounded max-h-48 overflow-y-auto">
            {loadingFolders ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : folders.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">No folders found</p>
            ) : (
              folders.map(f => (
                <div
                  key={f.id}
                  className="flex items-center justify-between px-3 py-2 hover:bg-muted/50 group"
                >
                  <button
                    className="flex items-center gap-2 text-sm flex-1 text-left hover:underline"
                    onClick={() => navigateInto(f)}
                  >
                    <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                    {f.name}
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="opacity-0 group-hover:opacity-100 h-7 text-xs"
                    onClick={() => selectFolder(f)}
                    disabled={saving}
                  >
                    Select
                  </Button>
                </div>
              ))
            )}
          </div>

          {folderError && (
            <p className="text-sm text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {folderError}
            </p>
          )}

          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" onClick={() => { setShowPicker(false); setFolderError(null); setUrlInput('') }}>
              Cancel
            </Button>
            <Button size="sm" onClick={selectCurrentFolder} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Use this folder
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={openPicker}>
          {folderId ? 'Change folder' : 'Pick folder'}
        </Button>
      )}

      {folderId && connected && (
        <GoogleDriveCompanyFolders fundId={fundId} />
      )}
    </div>
  )
}

function GoogleDriveCompanyFolders({ fundId }: { fundId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [companies, setCompanies] = useState<{ id: string; name: string; google_drive_folder_id: string | null; google_drive_folder_name: string | null }[]>([])
  const [loading, setLoading] = useState(false)
  const [pickerCompanyId, setPickerCompanyId] = useState<string | null>(null)
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([])
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string; shared?: boolean }[]>([{ id: null, name: 'My Drive' }])
  const [browseMode, setBrowseMode] = useState<'my' | 'shared'>('my')
  const [saving, setSaving] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')

  const loadCompanies = async () => {
    setLoading(true)
    const res = await fetch('/api/companies')
    if (res.ok) {
      const data = await res.json()
      // Fetch full details for each company to get folder overrides
      const detailed = await Promise.all(
        data.map(async (c: { id: string; name: string }) => {
          const r = await fetch(`/api/companies/${c.id}`)
          if (r.ok) {
            const d = await r.json()
            return { id: d.id, name: d.name, google_drive_folder_id: d.google_drive_folder_id ?? null, google_drive_folder_name: d.google_drive_folder_name ?? null }
          }
          return { id: c.id, name: c.name, google_drive_folder_id: null, google_drive_folder_name: null }
        })
      )
      setCompanies(detailed)
    }
    setLoading(false)
  }

  const handleExpand = () => {
    if (!expanded) loadCompanies()
    setExpanded(!expanded)
  }

  const loadFolders = async (parentId?: string, shared?: boolean) => {
    setLoadingFolders(true)
    setFolderError(null)
    try {
      let url = '/api/settings/drive/folders'
      if (shared) url += '?shared=true'
      else if (parentId) url += `?parent=${parentId}`
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setFolderError(data.error || 'Failed to list folders')
        return
      }
      const data = await res.json()
      setFolders(data.folders ?? [])
    } catch {
      setFolderError('Failed to list folders')
    } finally {
      setLoadingFolders(false)
    }
  }

  const openPicker = (companyId: string) => {
    setPickerCompanyId(companyId)
    setBrowseMode('my')
    setUrlInput('')
    setBreadcrumbs([{ id: null, name: 'My Drive' }])
    setFolderError(null)
    loadFolders()
  }

  // Resolve a pasted Drive folder URL → folder, then save it for this company.
  // Mirrors the fund-level picker; the resolve endpoint reads the folder name,
  // the company PATCH (in selectFolder) persists it.
  const selectByUrl = async (companyId: string) => {
    if (!urlInput.trim()) return
    setSaving(companyId)
    setFolderError(null)
    const res = await fetch('/api/settings/drive/folders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlInput.trim() }),
    })
    if (!res.ok) {
      setSaving(null)
      const data = await res.json().catch(() => ({}))
      setFolderError(data.error || 'Failed to use folder')
      return
    }
    const { folderId, folderName } = await res.json()
    setUrlInput('')
    await selectFolder(companyId, { id: folderId, name: folderName })
  }

  const selectFolder = async (companyId: string, folder: { id: string; name: string }) => {
    setSaving(companyId)
    const res = await fetch(`/api/companies/${companyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ google_drive_folder_id: folder.id, google_drive_folder_name: folder.name }),
    })
    setSaving(null)
    if (res.ok) {
      setPickerCompanyId(null)
      setCompanies(prev => prev.map(c => c.id === companyId ? { ...c, google_drive_folder_id: folder.id, google_drive_folder_name: folder.name } : c))
    }
  }

  const clearFolder = async (companyId: string) => {
    setSaving(companyId)
    const res = await fetch(`/api/companies/${companyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ google_drive_folder_id: null, google_drive_folder_name: null }),
    })
    setSaving(null)
    if (res.ok) {
      setCompanies(prev => prev.map(c => c.id === companyId ? { ...c, google_drive_folder_id: null, google_drive_folder_name: null } : c))
    }
  }

  const navigateInto = (folder: { id: string; name: string }) => {
    setBreadcrumbs(prev => [...prev, { id: folder.id, name: folder.name }])
    loadFolders(folder.id)
  }

  const navigateToBreadcrumb = (index: number) => {
    const crumb = breadcrumbs[index]
    setBreadcrumbs(prev => prev.slice(0, index + 1))
    if (crumb.shared) loadFolders(undefined, true)
    else loadFolders(crumb.id ?? undefined)
  }

  return (
    <div className="border-t pt-3 mt-3">
      <button onClick={handleExpand} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Company Folders
        <span className="font-normal">(optional overrides)</span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : companies.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No companies found.</p>
          ) : (
            <div className="border rounded-lg divide-y">
              {companies.map(c => (
                <div key={c.id} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{c.name}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      {c.google_drive_folder_id ? (
                        <>
                          <span className="text-xs text-muted-foreground truncate max-w-[200px]">{c.google_drive_folder_name}</span>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openPicker(c.id)} disabled={saving === c.id}>
                            Change
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-sm text-destructive hover:text-destructive" onClick={() => clearFolder(c.id)} disabled={saving === c.id}>
                            {saving === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                          </Button>
                        </>
                      ) : (
                        <>
                          <span className="text-xs text-muted-foreground">Default (auto-created)</span>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openPicker(c.id)}>
                            Set folder
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {pickerCompanyId === c.id && (
                    <div className="border rounded-card p-3 mt-2 space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-xs text-muted-foreground">Paste a Google Drive folder URL</label>
                        <div className="flex gap-2">
                          <Input
                            value={urlInput}
                            onChange={e => setUrlInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); selectByUrl(c.id) } }}
                            placeholder="https://drive.google.com/drive/folders/..."
                            className="h-8 text-sm"
                            disabled={saving === c.id}
                          />
                          <Button size="sm" onClick={() => selectByUrl(c.id)} disabled={saving === c.id || !urlInput.trim()}>
                            {saving === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Use'}
                          </Button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="h-px flex-1 bg-border" />
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">or browse</span>
                        <div className="h-px flex-1 bg-border" />
                      </div>

                      <div className="flex items-center gap-2 text-xs">
                        <button
                          onClick={() => { setBrowseMode('my'); setBreadcrumbs([{ id: null, name: 'My Drive' }]); loadFolders() }}
                          className={`px-2 py-1 rounded ${browseMode === 'my' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >My Drive</button>
                        <button
                          onClick={() => { setBrowseMode('shared'); setBreadcrumbs([{ id: null, name: 'Shared with me', shared: true }]); loadFolders(undefined, true) }}
                          className={`px-2 py-1 rounded ${browseMode === 'shared' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >Shared with me</button>
                      </div>

                      <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
                        {breadcrumbs.map((crumb, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {i > 0 && <ChevronRight className="h-3 w-3" />}
                            <button onClick={() => navigateToBreadcrumb(i)} className={`hover:text-foreground ${i === breadcrumbs.length - 1 ? 'text-foreground font-medium' : ''}`}>
                              {crumb.name}
                            </button>
                          </span>
                        ))}
                      </div>

                      <div className="border rounded max-h-36 overflow-y-auto">
                        {loadingFolders ? (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          </div>
                        ) : folders.length === 0 ? (
                          <p className="text-xs text-muted-foreground text-center py-4">No folders found</p>
                        ) : (
                          folders.map(f => (
                            <div key={f.id} className="flex items-center justify-between px-3 py-2 hover:bg-muted/50 group">
                              <button className="flex items-center gap-2 text-sm flex-1 text-left hover:underline" onClick={() => navigateInto(f)}>
                                <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                                {f.name}
                                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                              </button>
                              <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100 h-7 text-xs" onClick={() => selectFolder(c.id, f)} disabled={saving === c.id}>
                                Select
                              </Button>
                            </div>
                          ))
                        )}
                      </div>

                      {folderError && (
                        <p className="text-sm text-destructive flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" /> {folderError}
                        </p>
                      )}

                      <div className="flex gap-2 justify-end">
                        <Button size="sm" variant="outline" onClick={() => { setPickerCompanyId(null); setFolderError(null); setUrlInput('') }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
