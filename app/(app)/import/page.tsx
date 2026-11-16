'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, CheckCircle2, AlertCircle, Lock } from 'lucide-react'
import { ImportDocuments } from '@/components/import-documents'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { useFeatureVisibility } from '@/components/feature-visibility-context'

interface ImportResult {
  companiesCreated: number
  companiesMatched: number
  metricsCreated: number
  metricsMatched: number
  metricValuesCreated: number
  metricValuesSkipped: number
  sendersCreated: number
  errors: string[]
}

interface InvestmentImportResult {
  investmentsCreated: number
  proceedsCreated: number
  unrealizedCreated: number
  companiesMatched: number
  companiesCreated: number
  errors: string[]
}

export default function ImportPage() {
  const fv = useFeatureVisibility()
  const [text, setText] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Investment import state
  const [investmentText, setInvestmentText] = useState('')
  const [investmentImporting, setInvestmentImporting] = useState(false)
  const [investmentResult, setInvestmentResult] = useState<InvestmentImportResult | null>(null)
  const [investmentError, setInvestmentError] = useState<string | null>(null)

  async function handleImport() {
    if (!text.trim()) return
    setImporting(true)
    setResult(null)
    setError(null)

    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Import failed')
        return
      }

      setResult(data)
    } catch {
      setError('Something went wrong')
    } finally {
      setImporting(false)
    }
  }

  async function handleInvestmentImport() {
    if (!investmentText.trim()) return
    setInvestmentImporting(true)
    setInvestmentResult(null)
    setInvestmentError(null)

    try {
      const res = await fetch('/api/import/investments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: investmentText }),
      })

      const data = await res.json()
      if (!res.ok) {
        setInvestmentError(data.error ?? 'Import failed')
        return
      }

      setInvestmentResult(data)
    } catch {
      setInvestmentError('Something went wrong')
    } finally {
      setInvestmentImporting(false)
    }
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">{fv.imports === 'admin' && <Lock className="h-4 w-4 text-warning" />}Import</h1>
          <AnalystToggleButton />
        </div>
        <p className="text-sm text-muted-foreground">Upload documents and spreadsheets to populate your portfolio</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 max-w-3xl w-full">
      {/* Document Upload Section */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight mb-2">Document upload</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Upload documents (strategy decks, board materials, reports) and auto-match them to portfolio companies. These provide additional context for the AI analyst.
        </p>

        <ImportDocuments />
      </div>

      {/* Paste Data Section */}
      <div className="mt-12 pt-8 border-t">
        <h2 className="text-lg font-semibold tracking-tight mb-2">Paste company metrics</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Paste CSV or spreadsheet data from Google Sheets. Claude will parse it to create companies, metrics, and historical values.
        </p>

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <Alert className="mb-4">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>
              <div className="space-y-1">
                <p className="font-medium">Import complete</p>
                <ul className="text-sm space-y-0.5">
                  <li>{result.companiesCreated} companies created{result.companiesMatched > 0 ? `, ${result.companiesMatched} matched existing` : ''}</li>
                  <li>{result.metricsCreated} metrics created{result.metricsMatched > 0 ? `, ${result.metricsMatched} matched existing` : ''}</li>
                  <li>{result.metricValuesCreated} metric values imported{result.metricValuesSkipped > 0 ? `, ${result.metricValuesSkipped} skipped (already exist)` : ''}</li>
                  {result.sendersCreated > 0 && (
                    <li>{result.sendersCreated} authorized senders added</li>
                  )}
                </ul>
                {result.errors.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm font-medium text-destructive">Issues:</p>
                    <ul className="text-sm text-destructive space-y-0.5">
                      {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-4">
          <Textarea
            placeholder={`Paste your spreadsheet data here...\n\nExample:\nCompany, Fund, Sector, Stage, Email, MRR Q1 2025, MRR Q2 2025\nAcme Corp, Fund I, SaaS, Series A, cfo@acme.com, 50000, 65000\nBeta Inc, Fund II, Fintech, Seed, founder@beta.io, 12000, 15000`}
            value={text}
            onChange={e => setText(e.target.value)}
            rows={16}
            className="font-mono text-sm"
          />

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Supports CSV, tab-separated, or any tabular text format.
            </p>
            <Button onClick={handleImport} disabled={importing || !text.trim()}>
              {importing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {importing ? 'Importing...' : 'Import'}
            </Button>
          </div>
        </div>
      </div>

      {/* Investment Data Section */}
      <div className="mt-12 pt-8 border-t">
        <h2 className="text-lg font-semibold tracking-tight mb-2">Paste investment data</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Paste investment transaction data (rounds, proceeds, valuations). AI will parse and match to existing portfolio companies.
          Starting from scratch?{' '}
          <a href="/templates/investments-import.csv" download className="underline underline-offset-4 hover:text-foreground">
            Download a template
          </a>, fill it in, and paste the rows here.
        </p>

        {investmentError && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{investmentError}</AlertDescription>
          </Alert>
        )}

        {investmentResult && (
          <Alert className="mb-4">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>
              <div className="space-y-1">
                <p className="font-medium">Import complete</p>
                <ul className="text-sm space-y-0.5">
                  {investmentResult.investmentsCreated > 0 && (
                    <li>{investmentResult.investmentsCreated} investment transaction{investmentResult.investmentsCreated !== 1 ? 's' : ''} created</li>
                  )}
                  {investmentResult.proceedsCreated > 0 && (
                    <li>{investmentResult.proceedsCreated} proceeds transaction{investmentResult.proceedsCreated !== 1 ? 's' : ''} created</li>
                  )}
                  {investmentResult.unrealizedCreated > 0 && (
                    <li>{investmentResult.unrealizedCreated} unrealized change{investmentResult.unrealizedCreated !== 1 ? 's' : ''} created</li>
                  )}
                  <li>{investmentResult.companiesMatched} compan{investmentResult.companiesMatched !== 1 ? 'ies' : 'y'} matched</li>
                  {investmentResult.companiesCreated > 0 && (
                    <li>{investmentResult.companiesCreated} compan{investmentResult.companiesCreated !== 1 ? 'ies' : 'y'} created</li>
                  )}
                </ul>
                {investmentResult.errors.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm font-medium text-destructive">Issues:</p>
                    <ul className="text-sm text-destructive space-y-0.5">
                      {investmentResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-4">
          <Textarea
            placeholder={`Paste investment data here...\n\nExample:\nCompany, Round, Date, Amount Invested, Shares, Price/Share\nAcme Corp, Series A, 2024-03-15, 500000, 50000, 10.00\nBeta Inc, Seed, 2023-11-01, 250000, 100000, 2.50`}
            value={investmentText}
            onChange={e => setInvestmentText(e.target.value)}
            rows={12}
            className="font-mono text-sm"
          />

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Supports CSV, tab-separated, or free-form text. New companies will be created automatically.
            </p>
            <Button onClick={handleInvestmentImport} disabled={investmentImporting || !investmentText.trim()}>
              {investmentImporting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {investmentImporting ? 'Importing...' : 'Import Investments'}
            </Button>
          </div>
        </div>
      </div>
    </div>
    <AnalystPanel />
    </div>
    </div>
  )
}
