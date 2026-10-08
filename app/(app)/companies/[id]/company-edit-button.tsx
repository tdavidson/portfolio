'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { CompanyForm } from '@/components/company-form'
import type { Company } from '@/lib/types/database'

const TITLE = { company: 'Edit company', fund: 'Edit fund holding', crypto: 'Edit digital asset' } as const

export function CompanyEditButton({ company, holdingType = 'company' }: { company: Company; holdingType?: 'company' | 'fund' | 'crypto' }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{TITLE[holdingType]}</DialogTitle>
        </DialogHeader>
        <CompanyForm
          company={company}
          holdingType={holdingType}
          onSuccess={() => {
            setOpen(false)
            router.refresh()
          }}
          onDeleted={() => {
            setOpen(false)
            // Back to where the page's own back link goes: companies live on the dashboard, fund
            // holdings and digital assets on Investments.
            router.push(holdingType === 'company' ? '/dashboard' : '/investments')
            router.refresh()
          }}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
