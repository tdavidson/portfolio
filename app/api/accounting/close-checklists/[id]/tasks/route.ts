import { NextRequest } from 'next/server'
import { addTask, updateTasks } from '@/lib/close-checklist/service'
import { closeChecklistRequest, readJson } from '@/lib/close-checklist/http'

// A close checklist's tasks. PATCH updates several at once ({ updates: [{ task, status, tie_out,
// note, assignee, due_date, notes }] }) under the same rules as chat: only a done task is tied out,
// and not by the person who completed it. POST adds a task of the fund's own.

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const body = await readJson(req)
  return closeChecklistRequest('write', ctx => updateTasks(ctx, id, body.updates))
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const body = await readJson(req)
  return closeChecklistRequest('write', ctx => addTask(ctx, id, body))
}
