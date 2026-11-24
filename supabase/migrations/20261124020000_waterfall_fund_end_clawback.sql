-- The GP clawback at fund end, booked (lib/accounting/carry-clawback.ts). A close through the
-- vehicle's fund end date (or later) books carry paid beyond the GP's entitlement as owed back:
-- Dr 1370 Clawback receivable from GP / Cr each carry recipient's capital. The optional rate caps
-- each recipient's give-back at the carry it was paid less tax at that rate (a net-of-tax clawback).
-- Both are null until set; null books no clawback and applies no cap.

alter table public.vehicle_waterfall_terms
  add column if not exists fund_end_date date,
  add column if not exists clawback_net_of_tax_rate numeric
    check (clawback_net_of_tax_rate is null or (clawback_net_of_tax_rate >= 0 and clawback_net_of_tax_rate < 1));
