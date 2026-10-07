import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'
import { membersWhoCanSeeCompany } from '@/lib/access/company-audience'

interface NoteInfo {
  id: string
  content: string
  companyId: string | null
  companyName: string | null
  authorName: string
  authorUserId: string
  mentionedUserIds: string[]
}

/**
 * Send email notifications for a new note.
 *
 * Recipient logic:
 * - Fetch all fund members + their notification preferences
 * - If company note, fetch company subscriptions
 * - For each member (excluding author):
 *   - level='none' → skip
 *   - level='all' → send
 *   - level='mentions' (default) → send only if @mentioned
 *   - Has company subscription → send
 *
 * Fails silently — never throws.
 */
export async function sendNoteNotifications(
  admin: SupabaseClient,
  fundId: string,
  note: NoteInfo
): Promise<void> {
  try {
    // Get outbound email config — bail if not configured
    const config = await getOutboundConfig(admin, fundId, 'system')
    if (!config) return

    // Get fund name for email subject
    const { data: fund } = await admin
      .from('funds')
      .select('name')
      .eq('id', fundId)
      .maybeSingle() as { data: { name: string } | null }

    // Get system email from address
    const { data: fundSettings } = await admin
      .from('fund_settings')
      .select('system_email_from_name, system_email_from_address')
      .eq('fund_id', fundId)
      .maybeSingle() as { data: { system_email_from_name: string | null; system_email_from_address: string | null } | null }

    // Get all fund members
    const { data: members } = await admin
      .from('fund_members')
      .select('user_id, display_name')
      .eq('fund_id', fundId) as { data: { user_id: string; display_name: string | null }[] | null }

    if (!members || members.length === 0) return

    // Get notification preferences
    const { data: prefs } = await admin
      .from('note_notification_preferences' as any)
      .select('user_id, level')
      .eq('fund_id', fundId) as { data: { user_id: string; level: string }[] | null }

    const prefMap = new Map<string, string>()
    for (const p of prefs ?? []) {
      prefMap.set(p.user_id, p.level)
    }

    // Get company subscriptions if this is a company note
    const subscribedUserIds = new Set<string>()
    if (note.companyId) {
      const { data: subs } = await admin
        .from('note_company_subscriptions' as any)
        .select('user_id')
        .eq('company_id', note.companyId) as { data: { user_id: string }[] | null }

      for (const s of subs ?? []) subscribedUserIds.add(s.user_id)
    }

    const mentionSet = new Set(note.mentionedUserIds)

    // Determine recipients
    const recipientUserIds: string[] = []
    for (const member of members) {
      // Skip the author
      if (member.user_id === note.authorUserId) continue

      const level = prefMap.get(member.user_id) ?? 'mentions'

      if (level === 'none') continue
      if (level === 'all') {
        recipientUserIds.push(member.user_id)
        continue
      }
      // level === 'mentions'
      if (mentionSet.has(member.user_id)) {
        recipientUserIds.push(member.user_id)
        continue
      }
      // Company subscription
      if (subscribedUserIds.has(member.user_id)) {
        recipientUserIds.push(member.user_id)
      }
    }

    // A company note goes only to members who can see the company — whatever their preference or
    // mention: the email carries the note, so sending it would show them the company's data.
    if (note.companyId) {
      const audience = await membersWhoCanSeeCompany(admin, fundId, note.companyId)
      if (audience) {
        for (let i = recipientUserIds.length - 1; i >= 0; i--) {
          if (!audience.has(recipientUserIds[i])) recipientUserIds.splice(i, 1)
        }
      }
    }

    if (recipientUserIds.length === 0) return

    // Look up emails for recipients
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_BASE_URL || ''
    const fromName = fundSettings?.system_email_from_name || fund?.name || 'Portfolio'
    const fromAddress = fundSettings?.system_email_from_address || ''

    const subject = note.companyName
      ? `New note from ${note.authorName} on ${note.companyName}`
      : `New note from ${note.authorName}`

    const truncatedContent = note.content.length > 500
      ? note.content.slice(0, 500) + '...'
      : note.content

    for (const userId of recipientUserIds) {
      try {
        const { data: { user: recipient } } = await admin.auth.admin.getUserById(userId)
        if (!recipient?.email) continue

        const isMentioned = mentionSet.has(userId)
        const isSubscribed = subscribedUserIds.has(userId)
        const reason = isMentioned
          ? 'You were @mentioned in this note.'
          : isSubscribed
          ? `You follow ${note.companyName}.`
          : 'You receive all note notifications.'

        const html = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px;">
            <p style="margin: 0 0 12px;"><strong>${note.authorName}</strong>${note.companyName ? ` on <strong>${note.companyName}</strong>` : ''}:</p>
            <blockquote style="margin: 0 0 16px; padding: 12px 16px; background: #f5f5f5; border-left: 3px solid #ddd; border-radius: 4px; white-space: pre-wrap;">${truncatedContent}</blockquote>
            <p style="margin: 0 0 16px;"><a href="${siteUrl}/notes" style="color: #2563eb;">View in ${fromName}</a></p>
            <p style="margin: 0; color: #888; font-size: 12px;">${reason} <a href="${siteUrl}/settings" style="color: #888;">Manage preferences</a></p>
          </div>
        `.trim()

        await sendOutboundEmail(config, {
          to: recipient.email,
          from: fromAddress ? `${fromName} <${fromAddress}>` : undefined,
          subject,
          html,
        })
      } catch (err) {
        console.error(`[notes-notify] Failed to send to user ${userId}:`, err)
      }
    }
  } catch (err) {
    console.error('[notes-notify] Error in sendNoteNotifications:', err)
  }
}
