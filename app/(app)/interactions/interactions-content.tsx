'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { PortfolioNotesProvider, PortfolioNotesButton, PortfolioNotesPanel } from '@/components/portfolio-notes'
import { useFeatureVisibility } from '@/components/feature-visibility-context'
import { Lock, Copy, Check } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { RelationshipsList } from './relationships-list'

interface Interaction {
  id: string
  fund_id: string
  company_id: string | null
  email_id: string | null
  user_id: string
  tags: string[]
  subject: string | null
  summary: string | null
  intro_contacts: any
  body_preview: string | null
  interaction_date: string
  created_at: string
  company_name: string | null
}

export function InteractionsContent({ interactions, company = null }: {
  interactions: Interaction[]
  /** Set when the list is one company's (a company page's "View all"). */
  company?: { id: string; name: string } | null
}) {
  const fv = useFeatureVisibility()
  const [inboundAddress, setInboundAddress] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(s => {
      if (s?.postmarkInboundAddress) setInboundAddress(s.postmarkInboundAddress)
    }).catch(() => {})
  }, [])

  return (
    <PortfolioNotesProvider pageContext="interactions">
      <div className="p-4 md:py-8 md:pl-8 md:pr-4">
        <div className="mb-6 space-y-1">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">{fv.interactions === 'admin' && <Lock className="h-4 w-4 text-warning" />}Interactions</h1>
            <div className="flex items-center gap-2">
              <PortfolioNotesButton />
              <AnalystToggleButton />
            </div>
          </div>
          {company ? (
            <p className="text-sm text-muted-foreground">
              With <Link href={`/companies/${company.id}`} className="text-foreground underline underline-offset-4">{company.name}</Link>
              {' '}&middot;{' '}
              <Link href="/interactions" className="underline underline-offset-4 hover:text-foreground">Show all</Link>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Lightweight CRM to track qualitative value-adds across the portfolio</p>
          )}
          {inboundAddress && (
            <div className="flex items-end gap-1.5 pt-2">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Send emails to</label>
                <Input type="text" readOnly value={inboundAddress}
                  className="h-8 w-64 text-sm bg-muted text-muted-foreground cursor-default" />
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(inboundAddress)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
                className="text-muted-foreground hover:text-foreground transition-colors mb-1.5"
                title="Copy to clipboard"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col lg:flex-row gap-6 items-start">
          <div className="flex-1 min-w-0 w-full max-w-5xl">
            <RelationshipsList interactions={interactions} />
          </div>
          <PortfolioNotesPanel />
          <AnalystPanel />
        </div>
      </div>
    </PortfolioNotesProvider>
  )
}
