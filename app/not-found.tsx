import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center">
        <p className="text-7xl font-semibold tracking-tight mb-2">404</p>
        {/* One message for "no such page" and "not shared with you": telling them apart would confirm
            that something exists. */}
        <p className="text-lg text-muted-foreground mb-6">This page isn&apos;t available — it may not exist, or it isn&apos;t shared with you.</p>
        <Link
          href="/"
          className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Back to home
        </Link>
      </div>
    </div>
  )
}
