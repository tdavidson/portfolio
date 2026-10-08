/**
 * DELETE one investment transaction and say why when the server refuses (e.g. the 409 "edit it from
 * the fund register" text), instead of the click silently doing nothing.
 */
export async function deleteInvestmentTransaction(
  companyId: string,
  txnId: string,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await doFetch(`/api/companies/${companyId}/investments/${txnId}`, { method: 'DELETE' })
    if (res.ok) return { ok: true }
    const data = await res.json().catch(() => ({}))
    return { ok: false, error: typeof data?.error === 'string' && data.error ? data.error : 'Failed to delete transaction' }
  } catch {
    return { ok: false, error: 'Failed to delete transaction' }
  }
}
