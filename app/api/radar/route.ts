import { NextResponse, type NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })

const EXCLUDED = new Set([
  'USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'USDBC', 'ETH', 'BUSD', 'FRAX',
  'CBETH', 'CBBTC', 'CBUSD', 'AXLUSDC', 'USD+', 'STETH', 'RETH',
  'WSTETH', 'EURC', 'BSDETH',
])

type RiskLevel = 'DANGER' | 'CAUTION' | 'SAFE'

interface HoneypotResult {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  simulationSuccess: boolean
}

export interface RadarToken {
  name: string
  symbol: string
  contract: string
  ageMinutes: number
  liquidityUsd: number
  volume24h: number
  fdvUsd: number | null
  riskLevel: RiskLevel
  honeypot: HoneypotResult | null
  clarkVerdict: string | null
}

export interface RadarStats {
  totalNewTokens: number
  averageLiquidity: number
  mostCommonRisk: RiskLevel
  dangerCount: number
  cautionCount: number
  safeCount: number
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([promise.finally(() => clearTimeout(timer!)), timeout])
}

async function fetchHoneypot(contract: string): Promise<HoneypotResult | null> {
  try {
    const res = await fetch(
      `https://api.honeypot.is/v2/IsHoneypot?address=${contract}&chainID=8453`,
      { cache: 'no-store' }
    )
    if (!res.ok) return null
    const data = await res.json()
    return {
      isHoneypot:        data.honeypotResult?.isHoneypot        ?? null,
      buyTax:            data.simulationResult?.buyTax           ?? null,
      sellTax:           data.simulationResult?.sellTax          ?? null,
      simulationSuccess: data.simulationSuccess                  ?? false,
    }
  } catch {
    return null
  }
}

function scoreRisk(hp: HoneypotResult | null): RiskLevel {
  if (!hp || !hp.simulationSuccess) return 'SAFE'
  if (hp.isHoneypot === true) return 'DANGER'
  if ((hp.sellTax ?? 0) > 10 || (hp.buyTax ?? 0) > 10) return 'CAUTION'
  return 'SAFE'
}

function fmtK(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

async function getClarkVerdicts(tokens: Omit<RadarToken, 'clarkVerdict'>[]): Promise<Map<string, string>> {
  if (tokens.length === 0) return new Map()

  const lines = tokens.map((t, i) => {
    const hp  = t.honeypot
    const sec = hp?.simulationSuccess
      ? (hp.isHoneypot ? 'HONEYPOT' : `BuyTax:${hp.buyTax?.toFixed(1) ?? '0'}% SellTax:${hp.sellTax?.toFixed(1) ?? '0'}%`)
      : 'HP:UNVERIFIED'
    return `${i + 1}. [${t.contract}] ${t.name} (${t.symbol}) Age:${t.ageMinutes}min Liq:${fmtK(t.liquidityUsd)} Vol:${fmtK(t.volume24h)} ${sec} Risk:${t.riskLevel}`
  })

  const prompt =
    `You are Clark — Base chain radar analyst. For each new token give ONE punchy verdict (max 12 words). ` +
    `Lead with BUY, AVOID, or WATCH. If Risk=DANGER or HONEYPOT detected, always use AVOID.\n\n` +
    `Output ONLY these lines, nothing else. Format exactly: CONTRACT_ADDRESS|verdict\n\n` +
    lines.join('\n')

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    })

    const text     = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : ''
    const verdicts = new Map<string, string>()

    for (const line of text.split('\n')) {
      const pipe = line.indexOf('|')
      if (pipe === -1) continue
      const addr    = line.slice(0, pipe).trim()
      const verdict = line.slice(pipe + 1).trim()
      if (/^0x[a-fA-F0-9]{40}$/.test(addr) && verdict) {
        verdicts.set(addr.toLowerCase(), verdict)
      }
    }

    // Positional fallback if address parsing failed
    if (verdicts.size === 0) {
      text.split('\n').filter(Boolean).forEach((raw, i) => {
        if (tokens[i]) {
          const clean = raw.replace(/^\d+\.\s*/, '').replace(/^[^|]*\|/, '').trim()
          verdicts.set(tokens[i].contract.toLowerCase(), clean)
        }
      })
    }

    return verdicts
  } catch (err) {
    console.error('[radar] Clark verdict error:', err)
    return new Map()
  }
}

const EMPTY_STATS: RadarStats = { totalNewTokens: 0, averageLiquidity: 0, mostCommonRisk: 'SAFE', dangerCount: 0, cautionCount: 0, safeCount: 0 }

export async function GET(req: NextRequest) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  // Fetch new Base pools (shared cache for beta traffic)
  let gtResult: Awaited<ReturnType<typeof getOrFetchCached<Record<string, unknown>>>>
  try {
    gtResult = await getOrFetchCached<Record<string, unknown>>({
      key: 'coingecko:base-radar',
      ttlMs: 60_000,
      onLog: msg => console.info(`[radar] ${msg}`),
      fetcher: async () => {
        const ac = new AbortController()
        const tid = setTimeout(() => ac.abort(), 6000)
        try {
          const gtRes = await fetch(
            'https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=1&include=base_token%2Cquote_token',
            { headers: { Accept: 'application/json;version=20230302' }, cache: 'no-store', signal: ac.signal }
          )
          if (!gtRes.ok) throw new Error(`GeckoTerminal unavailable (${gtRes.status})`)
          return gtRes.json() as Promise<Record<string, unknown>>
        } finally {
          clearTimeout(tid)
        }
      },
    })
  } catch (err) {
    console.error('[radar] data source unavailable:', err)
    return NextResponse.json({ tokens: [], stats: EMPTY_STATS, fetchedAt: new Date().toISOString() })
  }

  try {

    const gtData = gtResult.data
    const pools    = Array.isArray(gtData?.data)     ? (gtData.data     as Record<string, unknown>[]) : []
    const included = Array.isArray(gtData?.included) ? (gtData.included as Record<string, unknown>[]) : []

    // Build token lookup from ?include= entities
    const tokenMap = new Map<string, { name: string; symbol: string; address: string }>()
    for (const item of included) {
      const attrs = item.attributes as Record<string, string> | undefined
      if (item.type === 'token' && attrs?.address) {
        tokenMap.set(item.id as string, {
          name:    attrs.name   ?? 'Unknown',
          symbol:  attrs.symbol ?? '?',
          address: attrs.address,
        })
      }
    }

    const now       = Date.now()
    const TWO_HOURS = 2  * 60 * 60 * 1000
    const DAY_MS    = 24 * 60 * 60 * 1000

    type Candidate = Omit<RadarToken, 'clarkVerdict'>
    const candidates: Candidate[] = []
    const allDay24h:  number[]    = []
    const seen = new Set<string>()

    for (const pool of pools) {
      const attrs = pool.attributes  as Record<string, unknown>         | undefined
      const rels  = pool.relationships as Record<string, unknown>       | undefined
      const volObj = attrs?.volume_usd as Record<string, string>        | undefined
      const createdAt = attrs?.pool_created_at as string | undefined
      if (!createdAt) continue

      const ageMs      = now - new Date(createdAt).getTime()
      const ageMinutes = Math.floor(ageMs / 60000)
      const liquidityUsd = parseFloat(String(attrs?.reserve_in_usd ?? '0')) || 0
      const volume24h    = parseFloat(volObj?.h24 ?? '0') || 0

      if (ageMs < DAY_MS && liquidityUsd >= 1000) allDay24h.push(liquidityUsd)

      if (ageMs  >= TWO_HOURS) continue
      if (liquidityUsd < 1000) continue

      const baseData    = ((rels?.base_token as Record<string, unknown>)?.data) as Record<string, string> | undefined
      const baseToken   = baseData?.id ? tokenMap.get(baseData.id) : undefined
      if (!baseToken) continue

      if (EXCLUDED.has(baseToken.symbol.toUpperCase())) continue

      const key = baseToken.address.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)

      const fdvUsd = parseFloat(String(attrs?.fdv_usd ?? '0')) || null
      candidates.push({
        name: baseToken.name, symbol: baseToken.symbol, contract: baseToken.address,
        ageMinutes, liquidityUsd, volume24h, fdvUsd, riskLevel: 'SAFE', honeypot: null,
      })
    }

    // Sort by liquidity to prioritise honeypot checks on biggest pools
    candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    const toCheck = candidates.slice(0, 10)

    // 2. Honeypot checks in parallel with 5s timeout each
    const hpResults = await Promise.allSettled(
      toCheck.map(t => withTimeout(fetchHoneypot(t.contract), 5000, null))
    )

    const scored: Candidate[] = toCheck.map((token, i) => {
      const hp = hpResults[i].status === 'fulfilled' ? hpResults[i].value : null
      return { ...token, honeypot: hp, riskLevel: scoreRisk(hp) }
    })

    // 3. Clark verdicts for top 5 by liquidity
    const top5     = [...scored].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 5)
    const verdicts = await getClarkVerdicts(top5)

    // 4. Final output — newest first for live feed
    const tokens: RadarToken[] = [...scored]
      .sort((a, b) => a.ageMinutes - b.ageMinutes)
      .map(t => ({ ...t, clarkVerdict: verdicts.get(t.contract.toLowerCase()) ?? null }))

    // 5. Stats
    const dangerCount  = scored.filter(t => t.riskLevel === 'DANGER').length
    const cautionCount = scored.filter(t => t.riskLevel === 'CAUTION').length
    const safeCount    = scored.filter(t => t.riskLevel === 'SAFE').length
    const avgLiq       = allDay24h.length > 0 ? allDay24h.reduce((s, v) => s + v, 0) / allDay24h.length : 0
    const mostCommonRisk: RiskLevel =
      dangerCount >= cautionCount && dangerCount >= safeCount ? 'DANGER'
      : cautionCount >= safeCount ? 'CAUTION' : 'SAFE'

    const stats: RadarStats = {
      totalNewTokens:   allDay24h.length,
      averageLiquidity: Math.round(avgLiq),
      mostCommonRisk,
      dangerCount, cautionCount, safeCount,
    }

    return NextResponse.json({ tokens, stats, fetchedAt: new Date().toISOString(), warning: gtResult.warning })
  } catch (err) {
    console.error('[radar] processing error:', err)
    return NextResponse.json({ tokens: [], stats: EMPTY_STATS, fetchedAt: new Date().toISOString() })
  }
}
