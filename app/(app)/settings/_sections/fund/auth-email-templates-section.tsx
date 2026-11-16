'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Section } from '@/components/settings/section'

const AUTH_EMAIL_TEMPLATES = [
  { name: 'Confirm signup', file: 'confirmation.html', desc: 'Sent when a user signs up' },
  { name: 'Invite user', file: 'invite.html', desc: 'Sent when an admin invites someone' },
  { name: 'One-time code', file: 'magic_link.html', desc: 'Passwordless sign-in code' },
  { name: 'Reset password', file: 'recovery.html', desc: 'Password reset request' },
  { name: 'Change email', file: 'email_change.html', desc: 'Confirm new email address' },
  { name: 'Reauthentication', file: 'reauthentication.html', desc: 'OTP code for re-verification' },
  { name: 'Password changed', file: 'password_changed.html', desc: 'Security notification' },
  { name: 'Email changed', file: 'email_changed.html', desc: 'Security notification' },
  { name: 'MFA added', file: 'mfa_factor_enrolled.html', desc: 'Security notification' },
  { name: 'MFA removed', file: 'mfa_factor_unenrolled.html', desc: 'Security notification' },
]

export function AuthEmailTemplatesSection() {
  const [showGuide, setShowGuide] = useState(false)

  return (
    <Section title="Authentication">
      <p className="text-xs text-muted-foreground mb-3">
        Email/password authentication is handled by Supabase Auth. This install includes preconfigured email templates for all authentication emails, signup confirmation, invitations, password reset, one-time sign-in codes, email change, and security notifications.
      </p>

      {showGuide ? (
        <div className="space-y-3">
          <button onClick={() => setShowGuide(false)} className="text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1">
            <ChevronDown className="h-3 w-3" /> Setup instructions
          </button>

          <div className="text-xs text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">If self-hosting with Supabase CLI:</p>
            <p>Templates are applied automatically from <code className="text-[11px] bg-muted px-1 rounded font-mono">templates/</code> via <code className="text-[11px] bg-muted px-1 rounded font-mono">config.toml</code>, no action needed.</p>

            <p className="font-medium text-foreground pt-2">If using hosted Supabase (dashboard):</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Go to your Supabase project dashboard → <strong>Authentication</strong> → <strong>Email templates</strong></li>
              <li>For each template type, copy the HTML from the corresponding file in <code className="text-[11px] bg-muted px-1 rounded font-mono">templates/</code></li>
              <li>Update the subject line to match</li>
            </ol>

            <p className="font-medium text-foreground pt-2">SMTP provider:</p>
            <p>
              To send real emails, configure an SMTP provider in your Supabase dashboard under <strong>Project Settings → Auth → SMTP Settings</strong>, or in <code className="text-[11px] bg-muted px-1 rounded font-mono">config.toml</code> under <code className="text-[11px] bg-muted px-1 rounded font-mono">[auth.email.smtp]</code>.
            </p>

            <p className="font-medium text-foreground pt-2">Auth hook (signup whitelist):</p>
            <p>
              A <code className="text-[11px] bg-muted px-1 rounded font-mono">before-user-created</code> auth hook enforces the signup whitelist at the database level, preventing direct signups that bypass the API.
            </p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Run the migration in <code className="text-[11px] bg-muted px-1 rounded font-mono">migrations/20260306120000_before_user_created_hook.sql</code></li>
              <li>Go to <strong>Authentication → Hooks</strong> in your Supabase dashboard</li>
              <li>Enable <strong>Before User Created</strong>, select <strong>Postgres Function</strong>, and choose <code className="text-[11px] bg-muted px-1 rounded font-mono">hook_before_user_created</code></li>
            </ol>
          </div>

          <div className="border rounded-md overflow-hidden mt-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-3 py-1.5 font-medium">Template</th>
                  <th className="text-left px-3 py-1.5 font-medium">File</th>
                  <th className="text-left px-3 py-1.5 font-medium hidden sm:table-cell">Description</th>
                </tr>
              </thead>
              <tbody>
                {AUTH_EMAIL_TEMPLATES.map((t) => (
                  <tr key={t.file} className="border-b last:border-0">
                    <td className="px-3 py-1.5">{t.name}</td>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{t.file}</td>
                    <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">{t.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            <a
              href="https://supabase.com/docs/guides/local-development/customizing-email-templates"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Supabase email template docs
            </a>
          </p>
        </div>
      ) : (
        <button onClick={() => setShowGuide(true)} className="text-xs text-muted-foreground hover:text-foreground underline">
          Setup instructions
        </button>
      )}
    </Section>
  )
}
