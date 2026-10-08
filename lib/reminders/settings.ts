import { parseAddressList } from '@/lib/email'

const MAX_RECIPIENTS = 20

/** The reminder recipient list from free text. Empty is valid: it means "the fund's admins". */
export function parseRecipients(input: string | null | undefined): { value: string[] } | { invalid: string } {
  const parsed = parseAddressList(input)
  if (parsed.invalid) return { invalid: parsed.invalid }
  const value = parsed.value ? parsed.value.split(', ') : []
  if (value.length > MAX_RECIPIENTS) return { invalid: `more than ${MAX_RECIPIENTS} recipients` }
  return { value }
}

/** The digest's From header, formatted as lib/notes/notify.ts does for system email: the fund's
 *  system from-name (else the fund name) around its system from-address. Undefined without an
 *  address, so the provider's own default applies. */
export function fromHeader(system: { name: string | null; address: string | null }, fundName: string | null): string | undefined {
  const address = system.address?.trim()
  if (!address) return undefined
  const name = system.name?.trim() || fundName?.trim()
  return name ? `${name} <${address}>` : address
}

/**
 * Recipients who are fund members limited to some entities. The digest covers every entity — open
 * calls, unfunded LPs, onboarding, compliance — so sending it to them would show them the others'.
 * People outside the app (a fund administrator) are the admin's call and are not flagged.
 */
export function scopedRecipients(recipients: string[], members: Array<{ email: string; unscoped: boolean }>): string[] {
  const scoped = new Set(members.filter(m => !m.unscoped).map(m => m.email.trim().toLowerCase()))
  return recipients.filter(r => scoped.has(r.trim().toLowerCase()))
}
