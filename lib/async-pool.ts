// Run `worker` over `items`, at most `concurrency` at a time. For batches of outbound email: a few
// hundred sends should not all fire at once. Kept apart from lib/lp-report-pdf.ts (which has its
// own) so a caller that only emails does not pull headless Chromium into its function.
export async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runner = async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner))
}
