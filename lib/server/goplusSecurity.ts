// GOPLUS-HONEYPOT-FALLBACK, DISCLOSED: real secondary source for Trading Simulation (honeypot +
// tax) when honeypot.is (lib/server/honeypotSecurity.ts, the sole/primary provider) has no data
// for a token — previously the "fallback" was a hardcoded `const gpHoneypot: null = null` in
// app/api/token/route.ts (a real dead stub, not a live call), so any token honeypot.is didn't
// cover simply showed "Unverified"/"Open check" forever, regardless of chain or pool model. This
// calls GoPlus's real token_security API (the same one already used, working, by
// app/api/goplus/route.ts) and normalizes its fields into the same shape resolveSimulation
// returns, so it can be dropped into the existing honeypot response field as a real, clearly
// lower-confidence secondary read — never a fabricated result.

import { createHash } from 'crypto'

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1'
const GOPLUS_TIMEOUT_MS = 6_000

// GoPlus's token_security endpoint only covers these chain IDs — calling it for an unsupported
// chain would just be a wasted round trip, so callers should gate on this first.
export const GOPLUS_SUPPORTED_CHAIN_IDS = new Set([1, 56, 137, 8453])

export interface GoPlusHoneypotFallback {
  honeypot: boolean | null
  honeypotStatus: 'confirmed' | 'unavailable' | 'failed' | 'not_supported' | 'timeout'
  honeypotReason: string | null
  buyTax: number | null
  sellTax: number | null
  transferTax: number | null
  simulationSuccess: boolean | null
  source: 'goplus'
}

async function getAccessToken(key: string, secret: string): Promise<string | null> {
  try {
    const time = Math.floor(Date.now() / 1000)
    const sign = createHash('md5').update(key + time + secret).digest('hex').toUpperCase()
    const res = await fetch(`${GOPLUS_BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_key: key, time, sign }),
      cache: 'no-store',
      signal: AbortSignal.timeout(GOPLUS_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json?.result?.access_token ?? null
  } catch {
    return null
  }
}

function parseFraction(value: unknown): number | null {
  // GoPlus reports buy_tax/sell_tax as a 0-1 fraction string (e.g. "0.05" = 5%), not a
  // percentage — this codebase's honeypot.is normalization (lib/server/honeypotSecurity.ts)
  // already stores taxes as whole percentages, so this converts to match that same convention.
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return n * 100
}

function parseGoPlusBool(value: unknown): boolean | null {
  if (value === '1') return true
  if (value === '0') return false
  return null
}

// Real read only — returns null (never a fabricated result) when GoPlus has no usable data for
// this token, the chain isn't supported, or the request fails/times out.
export async function fetchGoPlusHoneypotFallback(chainId: number, address: string): Promise<GoPlusHoneypotFallback | null> {
  if (!GOPLUS_SUPPORTED_CHAIN_IDS.has(chainId)) return null
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null

  try {
    const key = process.env.GOPLUS_APP_KEY
    const secret = process.env.GOPLUS_APP_SECRET
    const headers: Record<string, string> = { accept: 'application/json' }
    if (key && secret) {
      const token = await getAccessToken(key, secret)
      if (token) headers['Authorization'] = token
    }

    const res = await fetch(
      `${GOPLUS_BASE}/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
      { headers, cache: 'no-store', signal: AbortSignal.timeout(GOPLUS_TIMEOUT_MS) },
    )
    if (!res.ok) return null

    const json = await res.json().catch(() => null) as { result?: Record<string, unknown> } | null
    const tokenResult = json?.result?.[address.toLowerCase()] as Record<string, unknown> | undefined
    if (!tokenResult) return null

    const honeypot = parseGoPlusBool(tokenResult.is_honeypot) ?? parseGoPlusBool(tokenResult.cannot_sell_all)
    const buyTax = parseFraction(tokenResult.buy_tax)
    const sellTax = parseFraction(tokenResult.sell_tax)
    if (honeypot == null && buyTax == null && sellTax == null) return null

    return {
      honeypot,
      honeypotStatus: honeypot != null ? 'confirmed' : 'unavailable',
      honeypotReason: typeof tokenResult.note === 'string' && tokenResult.note ? tokenResult.note : null,
      buyTax,
      sellTax,
      transferTax: null,
      simulationSuccess: honeypot != null || buyTax != null || sellTax != null,
      source: 'goplus',
    }
  } catch {
    return null
  }
}
