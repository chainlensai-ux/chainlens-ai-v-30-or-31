// GET /api/diagnostics/pricing-source
//
// Standalone, no-query-param diagnostic — verifies whether the RUNNING process (whichever runtime
// actually executes this request — locally, or in Vercel's serverless functions once deployed) has
// a real GoldRush key, and whether pricingAtTimeEngine's primary/fallback sources actually work
// against it. Reuses the existing networkDiagnostics module and the pipeline's real, already-
// configured PRICE_SOURCES — does NOT modify fifoEngine, pnlSummaryV2, pricingAtTimeEngine, or
// timestamp logic anywhere.
//
// Path note: this repo's App Router root is `app/` (confirmed via next.config.ts — no `src/app`
// override, and every other real route in this codebase lives under app/api/...), not `pages/`.
// A `pages/api/...` file would be silently ignored by this project's routing.
//
// Test token: Base's real, canonical WETH9 predeploy address (0x4200...0006) — a well-documented,
// verifiable constant (part of Base's official predeploy set), not a guessed/fabricated address.

import { runPricingDiagnostics } from '@/src/modules/networkDiagnostics/networkDiagnostics'
import { PRICE_SOURCES } from '@/src/pipeline/index'

const TEST_TOKEN_WETH_BASE = '0x4200000000000000000000000000000000000006'
const TEST_CHAIN = 'base' as const

export async function GET(): Promise<Response> {
  const hasKey = Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY)
  // eslint-disable-next-line no-console
  console.log(`[pricing-source diagnostics] GOLDRUSH_API_KEY/COVALENT_API_KEY present = ${hasKey}`)

  // Recent, real timestamp (now) — never a fabricated/guessed date.
  const testTimestamp = Date.now()

  try {
    const result = await runPricingDiagnostics({
      chain: TEST_CHAIN,
      contract: TEST_TOKEN_WETH_BASE,
      timestamp: testTimestamp,
      priceSources: PRICE_SOURCES,
    })

    const primaryStatus: 'ok' | 'error' = result.primary.error ? 'error' : 'ok'
    // fallback is only actually called when primary resolved to null (see
    // pricingAtTimeEngine/utils.ts's resolvePriceForEntry) — "not called because primary already
    // succeeded" is a healthy outcome, not a failure, so it's reported as 'ok' here too; the fuller
    // called/not-called picture is in the console log below, not squeezed into this fixed shape.
    const fallbackStatus: 'ok' | 'error' = result.fallback.error ? 'error' : 'ok'
    const testPrice = result.primary.price ?? result.fallback.price ?? null

    // eslint-disable-next-line no-console
    console.log('[pricing-source diagnostics] primary', {
      called: result.primary.called,
      succeeded: primaryStatus === 'ok',
      price: result.primary.price,
      error: result.primary.error,
      durationMs: result.primary.durationMs,
    })
    // eslint-disable-next-line no-console
    console.log('[pricing-source diagnostics] fallback', {
      called: result.fallback.called,
      succeeded: fallbackStatus === 'ok',
      price: result.fallback.price,
      error: result.fallback.error,
      durationMs: result.fallback.durationMs,
    })

    return new Response(
      JSON.stringify({
        success: true,
        hasKey,
        primaryStatus,
        fallbackStatus,
        testPrice,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    // Never crashes the request — a genuinely unexpected failure still returns a shape-complete,
    // honest diagnostic rather than a 500 with no useful information.
    const message = err instanceof Error ? err.message : 'unknown_error'
    // eslint-disable-next-line no-console
    console.error('[pricing-source diagnostics] unexpected failure', message)

    return new Response(
      JSON.stringify({
        success: true,
        hasKey,
        primaryStatus: 'error' as const,
        fallbackStatus: 'error' as const,
        testPrice: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
