// POST /api/scan-v2 — returns the V2 engine's report split into modules: { success, modules }.
// Each module is exactly what a request to /api/scan-v2/modules/<name> would return for
// `modules.<name>` — this route just runs one scan and returns all 9 at once, for callers that
// want everything in a single round trip. runWalletScanV2 itself is unchanged; only the response
// shape is a reshaping of the same sanitized report (see src/deployment/api.ts buildModulesResponse).

import { router } from '@/src/deployment/index'
import { handleApiError } from '@/src/deployment/api'

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    // Env visibility check at the actual request boundary. Booleans only — never the raw key
    // value (this codebase never logs a raw secret anywhere; see src/deployment/env.ts's own
    // doc comment for the same rule). Uses console.warn, not console.log, because
    // next.config.ts's compiler.removeConsole strips console.log from production builds
    // (exclude: ['error', 'warn']) — a console.log here would silently never reach Vercel logs.
    console.warn('[scan-v2] env visibility check', {
      hasGoldrush: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY),
      hasAlchemyBase: Boolean(process.env.ALCHEMY_BASE_KEY ?? process.env.ALCHEMY_API_KEY),
      hasAlchemyEth: Boolean(process.env.ALCHEMY_ETHEREUM_KEY ?? process.env.ALCHEMY_API_KEY),
      hasAlchemyArbitrum: Boolean(process.env.ALCHEMY_ARBITRUM_KEY),
      runtime: process.env.NEXT_RUNTIME ?? 'nodejs (default — no edge runtime configured)',
      vercelEnv: process.env.VERCEL_ENV ?? null,
    })

    const result = await router.handleModulesRequest(rawBody, ip)

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify(handleApiError(err)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
