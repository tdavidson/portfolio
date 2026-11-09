import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useAppNavigate } from '@/components/app-runtime'
import { useLinker } from '../hrefs'

/**
 * `next/link` for the widget bundle: an anchor that hands the href to the runtime's `navigate`.
 * Next-only props are swallowed so they never reach the DOM. The href written is the host's URL
 * for the page (hrefs.ts: `/demo/companies/<id>` under `basePath: '/demo'`), so a new tab or a
 * copied link opens the demo; the app's path rides along as `data-app-href`.
 */
type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string | { pathname?: string }
  prefetch?: boolean | null
  replace?: boolean
  scroll?: boolean
  shallow?: boolean
  children?: ReactNode
}

export default function Link({ href, prefetch: _prefetch, replace: _replace, scroll: _scroll, shallow: _shallow, onClick, children, ...rest }: Props) {
  const navigate = useAppNavigate()
  const linker = useLinker()
  const target = typeof href === 'string' ? href : (href.pathname ?? '/')
  const resolved = linker.resolve(target)
  return (
    <a
      href={resolved.href}
      data-app-href={resolved.appHref ?? undefined}
      download={resolved.download}
      aria-hidden={resolved.hidden || undefined}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e)
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || resolved.download !== undefined) return
        e.preventDefault()
        navigate(target)
      }}
      {...rest}
      style={resolved.hidden ? { ...rest.style, display: 'none' } : rest.style}
    >
      {children}
    </a>
  )
}
