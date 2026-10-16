import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { VehiclePageScope, useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'

it('scopes the very first render and request to the URL vehicle without waiting for effects', async () => {
  let request!: ReturnType<typeof useLedgerFetch>
  function Child() {
    request = useLedgerFetch()
    const { group, vehicleId } = useVehicle()
    return <span>{group}:{vehicleId}</span>
  }
  const html = renderToStaticMarkup(<VehiclePageScope name="Synthetic Fund" id="vehicle-a"><Child /></VehiclePageScope>)
  expect(html).toContain('Synthetic Fund:vehicle-a')
  const fetch = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  try {
    await request('/api/accounting/ledger?preset=itd')
    expect(fetch.mock.calls[0][0]).toBe('/api/accounting/ledger?preset=itd&group=Synthetic%20Fund')
  } finally { vi.unstubAllGlobals() }
})
