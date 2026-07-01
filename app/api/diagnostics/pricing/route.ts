// GET /api/diagnostics/pricing?chain=base&contract=0xabc&timestamp=1234567890
//
// Standalone, manually-invoked diagnostic — NOT part of the wallet-scan pipeline. Verifies whether
// the pricing sources actually configured for real scans (src/pipeline/index.ts's PRICE_SOURCES —
// real GoldRush when GOLDRUSH_API_KEY/COVALENT_API_KEY is set, honestly noPriceSources() otherwise)
// are really being called and returning usable data, by calling the exact same functions
// runWalletScan() itself uses. Read-only: never mutates pipeline state, never writes anything.
//
// Path note: this repo's App Router root is `app/` (confirmed via next.config.ts — no `src/app`
// override, and every other real route in this codebase lives under app/api/...), so this route is
// app/api/diagnostics/pricing/route.ts, not src/app/api/diagnostics/pricing/route.ts.

import { runPricingDiagnostics } from '@/src/modules/networkDiagnostics/networkDiagnostics'
import { PRICE_SOURCES } from '@/src/pipeline/index'
import { SUPPORTED_CHAINS } from '@/src/pipeline/types'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const chain = searchParams.get('chain')
  const contract = searchParams.get('contract')
  const timestampRaw = searchParams.get('timestamp')

  const errors: string[] = []
  if (!chain) errors.push('chain query param is required')
  else if (!SUPPORTED_CHAINS.includes(chain as (typeof SUPPORTED_CHAINS)[number])) {
    errors.push(`chain must be one of: ${SUPPORTED_CHAINS.join(', ')}`)
  }
  if (!contract) errors.push('contract query param is required')

  const timestamp = timestampRaw != null ? Number(timestampRaw) : NaN
  if (!Number.isFinite(timestamp)) errors.push('timestamp query param must be a valid number (milliseconds)')

  if (errors.length > 0) {
    return new Response(JSON.stringify({ success: false, error: { message: 'Invalid request.', details: errors } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await runPricingDiagnostics({
      chain: chain as SupportedChain,
      contract: contract as string,
      timestamp,
      priceSources: PRICE_SOURCES,
    })
    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    // runPricingDiagnostics itself never throws (see its own doc comment), but this route still
    // guards against a genuinely unexpected failure rather than crashing the request.
    return new Response(JSON.stringify({ success: false, error: { message: err instanceof Error ? err.message : 'unknown_error' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
