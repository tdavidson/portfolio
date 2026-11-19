// The request scope for the period close's read cache (close-cache.ts). Kept apart because it needs
// `node:async_hooks`, and close-cache.ts is reached from modules that also land in browser bundles.
// Only server code that runs a close imports this file.

import { AsyncLocalStorage } from 'node:async_hooks'
import { installCloseCacheStore } from './close-cache'

const store = new AsyncLocalStorage<WeakMap<object, any>>()
installCloseCacheStore(() => store.getStore())

/**
 * Run `fn` with the close's read cache on. Nested calls share the outer scope. The cache is keyed
 * by the admin client, so it never crosses requests (each request makes its own client) and ends
 * with `fn`.
 */
export function withCloseCache<T>(fn: () => Promise<T>): Promise<T> {
  if (store.getStore()) return fn()
  return store.run(new WeakMap(), fn)
}
