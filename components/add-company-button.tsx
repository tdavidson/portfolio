'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DialogControl } from '@/components/add-investment-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CompanyForm } from '@/components/company-form'

/** Create a portfolio company from a modal, then open its page. */
export function AddCompanyButton({ open: openProp, onOpenChange, hideTrigger }: DialogControl = {}) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (o: boolean) => { setOpenState(o); onOpenChange?.(o) }
  const router = useRouter()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground">
          <Plus className="h-3.5 w-3.5" />Add company
        </Button>
      </DialogTrigger>
      )}
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add company</DialogTitle>
        </DialogHeader>
        <CompanyForm
          onSuccess={company => { setOpen(false); router.push(`/companies/${company.id}`) }}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
