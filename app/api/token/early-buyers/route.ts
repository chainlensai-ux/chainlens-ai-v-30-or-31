import { NextResponse } from 'next/server'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { analyzeEarlyBuyers } from '@/lib/server/earlyBuyers/analyze'
import { readEarlyBuyerEvidence } from '@/lib/server/earlyBuyers/store'
import { reserveEarlyBuyerAnalysis } from '@/lib/server/earlyBuyers/limits'
import { EARLY_BUYER_WINDOW_SCOPE, type EarlyBuyerChain, type EarlyBuyerIntel } from '@/lib/server/earlyBuyers/types'

export const runtime = 'nodejs'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export async function POST(request: Request) {
  const user = await requireAuthenticatedUser(request)
  if (!user) return unauthorizedResponse()
  let body: { chain?: unknown; contract?: unknown }
  try { body = await request.json() as typeof body } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  if (body.chain !== 'base' && body.chain !== 'eth') {
    const intel: EarlyBuyerIntel = { status: 'unsupported_chain', launch: { status: 'unavailable', block: null, pool: null, creationTx: null, liquidityTx: null }, window: { startBlock: null, endBlock: null, pools: [], buysObserved: 0 }, buyers: [], groups: [], sameBlockCount: 0, launchDistributions: [], coverage: { capped: false, reasons: ['base_and_ethereum_only'], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE }, budget: { calls: 0, cu: 0 } }
    return NextResponse.json({ earlyBuyerIntel: intel }, { headers: { 'Cache-Control': 'no-store' } })
  }
  if (typeof body.contract !== 'string' || !ADDRESS.test(body.contract)) return NextResponse.json({ error: 'invalid_contract' }, { status: 400 })
  const chain = body.chain as EarlyBuyerChain
  const token = body.contract.toLowerCase()
  const cached = await readEarlyBuyerEvidence(chain, token)
  if (cached) return NextResponse.json({ earlyBuyerIntel: await analyzeEarlyBuyers(chain, token, { cachedOnly: true, refreshHoldings: user.plan !== 'free' }) }, { headers: { 'Cache-Control': 'no-store' } })
  if (user.plan === 'free') return NextResponse.json({ earlyBuyerIntel: await analyzeEarlyBuyers(chain, token, { cachedOnly: true }) }, { headers: { 'Cache-Control': 'no-store' } })
  const reservation = await reserveEarlyBuyerAnalysis(user.userId, user.plan, chain, token)
  if (!reservation.allowed) {
    if (reservation.reason === 'token_in_progress') {
      const until = Date.now() + 24_000
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 800))
        const shared = await readEarlyBuyerEvidence(chain, token)
        if (shared) return NextResponse.json({ earlyBuyerIntel: shared }, { headers: { 'Cache-Control': 'no-store' } })
      }
    }
    return NextResponse.json({ error: reservation.reason }, { status: 429, headers: { 'Cache-Control': 'no-store' } })
  }
  let cu = 2_000
  try {
    const intel = await analyzeEarlyBuyers(chain, token)
    cu = intel.budget.cu
    return NextResponse.json({ earlyBuyerIntel: intel }, { headers: { 'Cache-Control': 'no-store' } })
  } finally {
    await reservation.settle(cu)
  }
}
