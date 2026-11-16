'use client'

import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { ProcessingActions } from './processing-actions'
import { UploadDocumentButton } from './upload-document-button'
import { SaveToDriveButton } from './save-to-drive-button'
import { CollapsibleJson } from './collapsible-json'
import { ReviewItems } from './review-items'
import { EmailMetricsSection } from './metrics-section'
import { AttachmentList } from './attachment-list'
import type { EmailPageData, MetricDef, MetricRow } from './load'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_VARIANTS: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-muted text-muted-foreground border-border' },
  processing: { label: 'Processing', className: 'bg-info-subtle text-info border-info' },
  success: { label: 'Success', className: 'bg-success-subtle text-success border-success' },
  not_processed: { label: 'Skipped', className: 'bg-muted text-muted-foreground border-border' },
  failed: { label: 'Failed', className: 'bg-destructive-subtle text-destructive border-destructive' },
  needs_review: {
    label: 'Review',
    className: 'bg-warning-subtle text-warning border-warning',
  },
}

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatValue(mv: MetricRow, metric: MetricDef | null): string {
  const v = mv.value_number !== null ? String(mv.value_number) : (mv.value_text ?? '—')
  if (!metric?.unit) return v
  return metric.unit_position === 'prefix' ? `${metric.unit}${v}` : `${v} ${metric.unit}`
}

export function EmailPageView({ email, company, metricValues, metricsById, hasReviews, hasFileStorage, textBody, attachments }: EmailPageData) {
  const sv = STATUS_VARIANTS[email.processing_status ?? ''] ?? {
    label: email.processing_status ?? 'unknown',
    className: '',
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl space-y-6">
      {/* Back link */}
      <Link
        href="/emails"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        Email Log
      </Link>

      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-start gap-3 flex-wrap">
          <h1 className="text-xl font-semibold leading-tight flex-1">
            {email.subject ?? <span className="italic text-muted-foreground">(no subject)</span>}
          </h1>
          <span
            className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium shrink-0 ${sv.className}`}
          >
            {sv.label}
          </span>
        </div>
        <div className="text-sm text-muted-foreground space-y-0.5">
          <p>
            From <span className="font-medium text-foreground">{email.from_address}</span>
          </p>
          <p>{fmt(email.received_at ?? '')}</p>
          {company && (
            <p>
              Company: <span className="font-medium text-foreground">{company.name}</span>
            </p>
          )}
        </div>
      </div>

      {/* Error / warning message */}
      {email.processing_error && (() => {
        const isWarning = email.processing_status === 'success' || email.processing_status === 'needs_review' || email.processing_status === 'not_processed'
        return (
          <div className={`rounded-card border p-4 text-sm ${isWarning ? 'border-warning bg-warning-subtle text-warning' : 'border-destructive bg-destructive-subtle text-destructive'}`}>
            <p className="font-medium mb-1">{isWarning ? 'Warning' : 'Processing error'}</p>
            <p className="text-xs break-all">{email.processing_error}</p>
          </div>
        )
      })()}

      {/* Metrics written */}
      {metricValues.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-2">Metrics Written ({metricValues.length})</h2>
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                    Metric
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                    Period
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                    Value
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                    Confidence
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {metricValues.map(mv => {
                  const metric = metricsById[mv.metric_id] ?? null
                  return (
                    <tr key={mv.id}>
                      <td className="px-4 py-2.5 font-medium">{metric?.name ?? '—'}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{mv.period_label}</td>
                      <td className="px-4 py-2.5 tabular-nums">{formatValue(mv, metric)}</td>
                      <td className="px-4 py-2.5">
                        <ConfidenceBadge confidence={mv.confidence} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Review items */}
      <ReviewItems emailId={email.id} hasReviews={hasReviews} />

      {/* Company + metric configuration — the same options the review modal offers */}
      <EmailMetricsSection emailId={email.id} initialCompany={company} />

      {/* Attachments */}
      {attachments.length > 0 && (
        <AttachmentList emailId={email.id} attachments={attachments} />
      )}

      {/* Email body */}
      {textBody && (
        <section>
          <h2 className="text-base font-semibold mb-2">Email body</h2>
          <pre className="text-xs bg-muted rounded-card p-4 whitespace-pre-wrap break-words font-mono max-h-96 overflow-auto border">
            {textBody}
          </pre>
        </section>
      )}

      {/* Claude response */}
      {email.claude_response && (
        <section>
          <CollapsibleJson label="Claude's Response" data={email.claude_response} />
        </section>
      )}

      {/* Actions */}
      <section className="pt-2 border-t space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
          <div>
            <p className="text-sm font-medium">Upload document</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              If the report was linked rather than attached, upload it here so it can be processed with the email.
            </p>
          </div>
          <UploadDocumentButton emailId={email.id} />
        </div>

        {hasFileStorage && (
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
            <div>
              <p className="text-sm font-medium">Save to file storage</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Saves the email body and attachments to your connected file storage provider.
              </p>
            </div>
            <SaveToDriveButton emailId={email.id} />
          </div>
        )}

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
          <div>
            <p className="text-sm font-medium">Process or skip</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Choose the destination yourself, let classification decide, or intentionally skip the email.
              An explicit destination will not be overridden by classification.
            </p>
          </div>
          <ProcessingActions emailId={email.id} />
        </div>
      </section>
    </div>
  )
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const styles: Record<string, string> = {
    high: 'bg-success-subtle text-success border-success',
    medium: 'bg-warning-subtle text-warning border-warning',
    low: 'bg-destructive-subtle text-destructive border-destructive',
  }
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${styles[confidence] ?? ''}`}
    >
      {confidence}
    </span>
  )
}
