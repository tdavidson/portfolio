import { Github, Scale } from 'lucide-react'
import {
  COMPANY_NAME,
  COMPANY_SITE,
  PRIVACY_URL,
  PRODUCT_LICENSE,
  PRODUCT_NAME,
  PRODUCT_REPO,
  PRODUCT_SITE,
  TERMS_URL,
} from '@/lib/site-links'

// The Hemrock mark (monochrome via currentColor): the company behind the product.
function HemrockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M13 14L17 9L22 18H2.84444C2.46441 18 2.2233 17.5928 2.40603 17.2596L10.0509 3.31896C10.2429 2.96885 10.7476 2.97394 10.9325 3.32786L15.122 11.3476" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The in-app footer: the product, the company, the source, the licence, and the legal
 * pages when the deployment names them (NEXT_PUBLIC_TERMS_URL / NEXT_PUBLIC_PRIVACY_URL;
 * lib/site-links.ts). The marketing page that used to add social links and a demo
 * button to this footer lives at www.hemrock.com now.
 */
export function AppFooter({ variant = 'page' }: {
  /** `sidebar`: a compact list at the foot of the fixed sidebar (lib/nav/layout.ts) instead of a
   *  strip under the page. */
  variant?: 'page' | 'sidebar'
} = {}) {
  const compact = variant === 'sidebar'
  return (
    <footer className={compact ? 'px-3 pt-2 pb-1 shrink-0' : 'px-4 md:px-8 pt-2 pb-8 shrink-0'}>
      <ul className={compact
        ? 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'
        : 'flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-9 text-sm text-muted-foreground border-t pt-3'}>
        <li className="flex items-center gap-1.5">
          <a
            href={PRODUCT_SITE}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            {PRODUCT_NAME}
          </a>
          {' '}by{' '}
          <a
            href={COMPANY_SITE}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <HemrockIcon className="h-3.5 w-3.5" />
            {COMPANY_NAME}
          </a>
        </li>
        <li>
          <a
            href={PRODUCT_REPO}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          >
            View on <Github className="h-3 w-3" />
            GitHub
          </a>
        </li>
        <li>
          <a
            href={PRODUCT_LICENSE}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          >
            <Scale className="h-3 w-3" />
            License
          </a>
        </li>
        {TERMS_URL && (
          <li>
            <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
              Terms
            </a>
          </li>
        )}
        {PRIVACY_URL && (
          <li>
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
              Privacy
            </a>
          </li>
        )}
      </ul>
    </footer>
  )
}
