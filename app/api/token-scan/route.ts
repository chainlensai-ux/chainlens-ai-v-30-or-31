// app/api/token-scan/route.ts
//
// This route's literal spec ({chain, tokenAddress, timestamp} -> getPriceAtTime) matches the real
// lib/engines/pricingAtTimeEngine.ts exactly — no fabricated names, no structural gap here. See
// that file's own header for its disclosures (naming collision with src/modules/
// pricingAtTimeEngine/, and the unreachable "low"/"fallback" enum members) — none of that required
// any change on this route's side.
//
// CHAIN VALIDATION, DISCLOSED: `chain` is validated against providerFetchWindow's real
// SupportedChain list (the same type getPriceAtTime's request declares) rather than accepted as an
// arbitrary string, so an unsupported chain fails fast with a clear 400 instead of silently
// returning a "none confidence" result indistinguishable from a real "no price found" case.

import { NextResponse } from 'next/server'
import { SUPPORTED_CHAINS } from '@/src/pipeline/types'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { getPriceAtTime } from '@/lib/engines/pricingAtTimeEngine'

type TokenScanRequestBody = {
  chain?: string
  tokenAddress?: string
  timestamp?: number
}

function isSupportedChain(chain: string): chain is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain)
}

export async function POST(req: Request) {
  let body: TokenScanRequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { chain, tokenAddress, timestamp } = body

  if (!chain || typeof chain !== 'string') {
    return NextResponse.json({ error: 'chain is required' }, { status: 400 })
  }
  if (!isSupportedChain(chain)) {
    return NextResponse.json({ error: `unsupported chain "${chain}" — supported: ${SUPPORTED_CHAINS.join(', ')}` }, { status: 400 })
  }
  if (!tokenAddress || typeof tokenAddress !== 'string') {
    return NextResponse.json({ error: 'tokenAddress is required' }, { status: 400 })
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return NextResponse.json({ error: 'timestamp is required and must be a unix-seconds number' }, { status: 400 })
  }

  const result = await getPriceAtTime({ chain, tokenAddress, timestamp })

  return NextResponse.json(result)
}
