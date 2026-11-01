'use client'

import { FundRecords } from '@/components/fund-records'

/**
 * Fund records: what people and their assistants filed from a working session (lib/records). A
 * client page, so it declares nothing in page-domains.ts: the records arrive through /api/records,
 * which shows each one only to someone who reads its area and sees its entity.
 */
export default function RecordsPage() {
  return (
    <div className="p-4 md:p-8">
      <div className="max-w-4xl space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Records</h1>
        <p className="text-sm text-muted-foreground">
          What was concluded, decided or said in a working session, kept by the fund. Filed here, or from Claude or another
          assistant with file_to_record. Records can&apos;t be edited or deleted; a correction is a new record.
        </p>
      </div>
      <div className="mt-6 max-w-4xl">
        <FundRecords />
      </div>
    </div>
  )
}
