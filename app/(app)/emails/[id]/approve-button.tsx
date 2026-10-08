'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Check, Loader2 } from 'lucide-react'

export function ApproveButton({ emailId }: { emailId: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [leftOpen, setLeftOpen] = useState(0)

  async function handleApprove() {
    setLoading(true)
    try {
      const res = await fetch(`/api/emails/${emailId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_all' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to approve')
      }
      // Fund reviews are not approved in bulk (api/emails/[id]/reviews): they stay open.
      const json = await res.json().catch(() => ({}))
      setLeftOpen(Number(json?.leftOpen ?? 0))
      setDone(true)
      setTimeout(() => router.refresh(), 1500)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const n = leftOpen
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={handleApprove}
        disabled={loading || done}
        className="shrink-0 gap-1.5"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        {done ? 'Approved' : 'Approve'}
      </Button>
      {done && n > 0 && (
        <p role="status" className="text-sm text-warning">
          {`${n === 1 ? 'A fund review is' : `${n} fund reviews are`} still open. Approve ${n === 1 ? 'it' : 'each'} on its own, so the NAV or notice is saved with its entity.`}
        </p>
      )}
    </div>
  )
}
