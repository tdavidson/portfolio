'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { AppFooter } from '@/components/app-footer'
import { LogOut } from 'lucide-react'

const TABS: { href: string; label: string; match?: string[] }[] = [
  { href: '/portal/overview', label: 'Overview' },
  // Each of the investor's own dated capital movements.
  { href: '/portal/activity', label: 'Activity' },
  // Calls to fund and distributions coming: each with its notice, its status, and a way to say
  // "we've wired".
  { href: '/portal/notices', label: 'Notices' },
  { href: '/portal/onboarding', label: 'Onboarding' },
  // "Library" is the combined reports + letters + documents page at /portal/snapshots.
  { href: '/portal/snapshots', label: 'Library', match: ['/portal/snapshots', '/portal/letters', '/portal/documents'] },
  { href: '/portal/settings', label: 'Settings' },
  { href: '/portal/contact', label: 'Contact' },
]

/**
 * Portal header + tab nav, wrapping the portal pages. Onboarding
 * (/portal/welcome) is a standalone setup screen, so it renders the page bare —
 * no header, no tabs.
 */
export function PortalChrome({ fundName, logoUrl, userEmail, children }: { fundName: string; logoUrl: string | null; userEmail: string; children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname === '/portal/welcome') {
    return <>{children}</>
  }

  return (
    <div className="flex flex-col min-h-screen">
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4">
          <div className="pt-3 pb-2 flex items-center justify-between gap-3">
            <Link href="/portal/overview" className="flex items-center gap-2 min-w-0">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="" className="h-7 w-auto max-w-[140px] object-contain rounded shrink-0" />
              ) : null}
              <span className="font-medium text-sm text-muted-foreground tracking-tight truncate">{fundName}</span>
            </Link>
            <div className="flex items-center gap-3">
              {userEmail && <span className="text-xs text-muted-foreground truncate hidden sm:block max-w-[200px]">{userEmail}</span>}
              <form action="/api/auth/logout" method="POST">
                <Button type="submit" variant="outline" size="sm" className="text-muted-foreground gap-2">
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              </form>
            </div>
          </div>
          <nav className="flex items-center gap-4 -mb-px pt-2 overflow-x-auto">
            {TABS.map(t => {
              const active = (t.match ?? [t.href]).some(m => pathname === m || pathname.startsWith(m + '/'))
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className={`text-sm py-2 border-b-2 whitespace-nowrap ${active ? 'border-foreground text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {t.label}
                </Link>
              )
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-6">{children}</main>
      <div className="w-full max-w-5xl mx-auto">
        <AppFooter />
      </div>
    </div>
  )
}
