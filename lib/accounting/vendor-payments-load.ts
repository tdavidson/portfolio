import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from './load'
import { vehicleIdByName } from './vehicle-id'
import { ACTUAL_BOOK } from './books'
import { listVendors } from './vendors'
import { vendorPayments, type VendorPaymentRow } from './vendor-payments'

// The database side of the 1099 worksheet: the year's posted entries that name a vendor, with
// their postings, and the vehicle's cash accounts.

export async function loadVendorPayments(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  year: number,
): Promise<{ rows: VendorPaymentRow[]; totalPaid: number }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const start = `${year}-01-01`
  const end = `${year}-12-31`
  const [entries, { data: cashRows }, vendors] = await Promise.all([
    fetchAllRows<any>((f, t) => admin
      .from('journal_entries' as any)
      .select('id, entry_date, memo, reference, vendor_id, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .eq('status', 'posted')
      .not('vendor_id', 'is', null)
      .gte('entry_date', start)
      .lte('entry_date', end)
      .order('id').range(f, t)),
    admin.from('chart_of_accounts' as any).select('id').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('subtype', 'cash'),
    listVendors(admin, fundId),
  ])
  const cashIds = new Set(((cashRows as any[]) ?? []).map(r => r.id as string))
  return vendorPayments(
    entries.map(e => ({
      id: e.id, entryDate: e.entry_date, memo: e.memo ?? null, reference: e.reference ?? null, vendorId: e.vendor_id ?? null,
      postings: ((e.journal_postings as any[]) ?? []).map(p => ({ accountId: p.account_id, amount: Number(p.amount) })),
    })),
    vendors,
    cashIds,
    { start, end },
  )
}
