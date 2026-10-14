/**
 * Where the authorization code is about to go. Registration is open (RFC 7591), so the client's name
 * is whatever the client said it was: anyone can register "Claude" with their own redirect_uri. The
 * host it redirects to is the one thing on this screen the client cannot dress up, so show it.
 */
export function RedirectHost({ redirectUri }: { redirectUri: string }) {
  let shown = redirectUri
  try {
    const u = new URL(redirectUri)
    shown = u.protocol === 'http:' || u.protocol === 'https:' ? u.host : `${u.protocol}//`
  } catch {
    // Already exact-matched against the registration upstream; show it as it is.
  }
  return (
    <p className="text-xs text-muted-foreground">
      The name above is the app&apos;s own description of itself. If you allow it, you will be sent to{' '}
      <span className="font-medium text-foreground break-all">{shown}</span>. Continue only if you expected that.
    </p>
  )
}
