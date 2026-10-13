import { NextRequest } from 'next/server'
import { createChecklist, listChecklists } from '@/lib/close-checklist/service'
import { closeChecklistRequest, readJson } from '@/lib/close-checklist/http'

// Quarter-end close checklists. GET lists them; POST builds one from the fund's kind, its number of
// portfolio companies, its administrator and the LP delivery date (lib/close-checklist/template.ts).

export async function GET(req: NextRequest) {
  return closeChecklistRequest('read', ctx => listChecklists(ctx, { includeArchived: req.nextUrl.searchParams.get('archived') === '1' }))
}

export async function POST(req: NextRequest) {
  const body = await readJson(req)
  return closeChecklistRequest('write', ctx => createChecklist(ctx, {
    fundKind: body.fundKind,
    portfolioCompanies: body.portfolioCompanies,
    administrator: body.administrator,
    lpDeliveryDate: body.lpDeliveryDate,
    periodEnd: body.periodEnd,
    entity: body.entity,
    title: body.title,
  }))
}
