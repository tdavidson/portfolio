import { NextRequest } from 'next/server'
import { getChecklist, updateChecklist } from '@/lib/close-checklist/service'
import { closeChecklistRequest, readJson } from '@/lib/close-checklist/http'

// One close checklist: GET the view (tasks by owner, the critical task, the tie-out summary);
// PATCH its LP delivery date (tasks without their own date move with it), title or status.

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  return closeChecklistRequest('read', ctx => getChecklist(ctx, id))
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const body = await readJson(req)
  return closeChecklistRequest('write', ctx => updateChecklist(ctx, id, {
    lpDeliveryDate: body.lpDeliveryDate, title: body.title, status: body.status,
  }))
}
