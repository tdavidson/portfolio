// A test send: the exact LP email, sent once to the person pressing the button instead of to the
// LPs. Used by announcements, portal items (statements, letters, documents), notices and receipts,
// so a GP can see what an LP will get, attachment included, before anything goes out.
//
// Nothing a test does is recorded as an LP delivery or shows in any portal: it is not a send.

import type { SupabaseClient } from '@supabase/supabase-js'

/** The sender's own sign-in email, which is where a test goes. Null when it can't be read. */
export async function testRecipientEmail(admin: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data } = await admin.auth.admin.getUserById(userId)
    const email = data?.user?.email?.trim()
    return email || null
  } catch {
    return null
  }
}

export const TEST_SUBJECT_PREFIX = '[Test] '

export function testSubject(subject: string): string {
  return subject.startsWith(TEST_SUBJECT_PREFIX) ? subject : `${TEST_SUBJECT_PREFIX}${subject}`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Put a banner at the top of the email saying it is a test and who the real one goes to, so a
 * forwarded test can't be mistaken for the real thing.
 */
export function withTestBanner(html: string, sample: { to: string; cc: string[]; viaContact: boolean } | null): string {
  const who = sample
    ? `The real email goes to ${esc(sample.to)}${sample.cc.length ? ` (Cc ${esc(sample.cc.join(', '))})` : ''}${sample.viaContact ? ', the contact on file, with the PDF attached because they have no portal account' : ''}.`
    : 'No LP would receive this email yet.'
  const banner = `<div style="background-color:#fef3c7;color:#78350f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;padding:12px 20px;text-align:center;">Test send. Nothing went to any LP. ${who}</div>`
  const m = html.match(/<body[^>]*>/i)
  if (!m || m.index === undefined) return banner + html
  const at = m.index + m[0].length
  return html.slice(0, at) + banner + html.slice(at)
}

export interface TestSendResult {
  ok: true
  test: true
  sentTo: string
  /** The LP whose version of the email this was, so the GP knows which figures they are looking at. */
  sampleOf: string | null
}

export const NO_TEST_RECIPIENT = 'Could not read your sign-in email, so there is nowhere to send the test.'
