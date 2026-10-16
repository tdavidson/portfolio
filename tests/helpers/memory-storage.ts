// An in-memory stand-in for `admin.storage`, for tests of the upload paths: signed upload URLs,
// upload, download, list (with `search`), remove. Objects are keyed by bucket and path.

export function withMemoryStorage(admin: any) {
  const objects = new Map<string, Buffer>()
  const signed: { bucket: string; path: string }[] = []
  const key = (bucket: string, path: string) => `${bucket}::${path}`
  admin.storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (path: string) => {
        signed.push({ bucket, path })
        return { data: { signedUrl: `https://store.test/storage/v1/object/upload/sign/${bucket}/${path}?token=tok`, token: 'tok', path }, error: null }
      },
      upload: async (path: string, body: Buffer) => { objects.set(key(bucket, path), Buffer.from(body)); return { data: { path }, error: null } },
      download: async (path: string) => {
        const b = objects.get(key(bucket, path))
        return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: 'Object not found' } }
      },
      remove: async (paths: string[]) => { for (const p of paths) objects.delete(key(bucket, p)); return { data: null, error: null } },
      list: async (folder: string, opts?: { search?: string }) => {
        const prefix = key(bucket, `${folder}/`)
        const data = [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && k.slice(prefix.length).includes(opts?.search ?? ''))
          .map(([k, b]) => ({ name: k.slice(prefix.length), metadata: { size: b.length } }))
        return { data, error: null }
      },
    }),
  }
  return {
    objects,
    signed,
    /** What the assistant's PUT to a signed URL would have stored. */
    put: (bucket: string, path: string, bytes: Buffer | string) => objects.set(key(bucket, path), Buffer.from(bytes)),
    has: (bucket: string, path: string) => objects.has(key(bucket, path)),
  }
}
