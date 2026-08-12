import { NextResponse, type NextRequest } from 'next/server'
import { getRadarSimulationDisplay, type RadarSimulationOpenCheckReason } from '@/lib/baseRadarSimulation'
import { fetchHoneypotSecurity } from '@/lib/server/honeypotSecurity'

const VALID_ADDRESS = /^0x[a-fA-F0-9]{40}$/

function num(value: string | null): number | null {
  if (value == null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mapFailureReason(status: string | null | undefined): RadarSimulationOpenCheckReason {
  if (status === 'timeout') return 'timeout_after_retry'
  if (status === 'not_supported') return 'unsupported_pool_model'
  if (status === 'failed' || status === 'unavailable') return 'provider_unavailable'
  return 'provider_unavailable'
}

function tradingRiskFlags(input: { isHoneypot: boolean | null; buyTax: number | null; sellTax: number | null; simulationSuccess: boolean | null }): string[] {
  const flags: string[] = []
  if (input.isHoneypot === true) flags.push('Honeypot behavior flagged')
  if ((input.buyTax ?? 0) > 15) flags.push('High buy tax')
  if ((input.sellTax ?? 0) > 15) flags.push('High sell tax')
  if (input.simulationSuccess === false) flags.push('Buy/sell simulation failed')
  if (input.simulationSuccess == null) flags.push('Buy/sell simulation inconclusive')
  return flags
}

// HONEYPOT-CHAIN-GUARD, DISCLOSED (found in a full Base Radar audit): fetchHoneypotSecurity maps its
// chain argument as `chain === "base" ? "8453" : String(chain)` (lib/server/honeypotSecurity.ts), so
// forwarding an arbitrary slug like 'robinhood' produced a literal `chainID=robinhood` query to
// honeypot.is. That is not just a wasted call — if honeypot.is ignores an unrecognized chainID and
// falls back to its own default chain, it returns a REAL, confident buy/sell verdict for the WRONG
// chain, and this route's result is written straight back onto the feed row by the drawer's
// handleDrawerSimulationUpdate (it can flip a token to simulationStatus 'passed' and clear its
// evidence gaps). app/api/radar/route.ts's own fetchHoneypot already deliberately refuses Robinhood
// for exactly this reason; this route bypassed that guard entirely. Only chains with a verified
// numeric EVM chain ID that honeypot.is is known to accept are forwarded; anything else short-
// circuits to the same honest not_supported shape a real provider rejection produces, never a
// fabricated or wrong-chain verdict.
const HONEYPOT_SUPPORTED_CHAIN_IDS: Record<string, string> = {
  base: '8453',
  eth: '1',
  ethereum: '1',
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const address = url.searchParams.get('address') ?? url.searchParams.get('contract') ?? ''
  const chain = url.searchParams.get('chain') ?? 'base'
  const liquidityUsd = num(url.searchParams.get('liquidityUsd'))
  const pairAddress = url.searchParams.has('pairAddress') ? url.searchParams.get('pairAddress') : undefined

  if (!VALID_ADDRESS.test(address)) {
    return NextResponse.json({ error: 'Invalid token address' }, { status: 400 })
  }

  const honeypotChainId = HONEYPOT_SUPPORTED_CHAIN_IDS[chain.toLowerCase()]
  if (!honeypotChainId) {
    const honeypot = { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: 'unsupported_pool_model' as RadarSimulationOpenCheckReason }
    const simulation = getRadarSimulationDisplay({ contract: address, liquidityUsd, pairAddress, honeypot })
    return NextResponse.json({
      address,
      chain,
      simulationStatus: simulation.status,
      simulationReason: simulation.reason,
      simulationLabel: simulation.label,
      simulationCortexLine: simulation.cortexLine,
      buySellSimulation: { buyTax: null, sellTax: null, slippage: null, failureRate: null, isHoneypot: null, simulationSuccess: null, providerStatus: 'not_supported' },
      riskFlags: tradingRiskFlags(honeypot),
      security: {
        honeypot: { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: simulation.reason },
        openChecks: ['Buy/sell simulation is not supported on this chain by the security provider; treat tax and honeypot status as unconfirmed.'],
      },
    })
  }

  const [security] = await Promise.all([
    fetchHoneypotSecurity(address, honeypotChainId),
  ])

  const honeypot = {
    isHoneypot: security.honeypot,
    buyTax: security.buyTax,
    sellTax: security.sellTax,
    simulationSuccess: security.simulationSuccess,
    failureReason: mapFailureReason(security.simulationStatus),
  }
  const simulation = getRadarSimulationDisplay({ contract: address, liquidityUsd, pairAddress, honeypot })
  const riskFlags = tradingRiskFlags(honeypot)

  return NextResponse.json({
    address,
    chain,
    simulationStatus: simulation.status,
    simulationReason: simulation.reason,
    simulationLabel: simulation.label,
    simulationCortexLine: simulation.cortexLine,
    buySellSimulation: {
      buyTax: simulation.status === 'passed' ? simulation.buyTax : security.buyTax,
      sellTax: simulation.status === 'passed' ? simulation.sellTax : security.sellTax,
      slippage: null,
      failureRate: simulation.status === 'passed' ? 0 : null,
      isHoneypot: security.honeypot,
      simulationSuccess: security.simulationSuccess,
      providerStatus: security.simulationStatus,
    },
    riskFlags,
    security: {
      honeypot: {
        isHoneypot: security.honeypot,
        buyTax: simulation.status === 'passed' ? simulation.buyTax : security.buyTax,
        sellTax: simulation.status === 'passed' ? simulation.sellTax : security.sellTax,
        simulationSuccess: security.simulationSuccess,
        failureReason: simulation.reason,
      },
      openChecks: simulation.status === 'passed' ? [] : ['Simulation checked but remains inconclusive; keep conservative caps.'],
    },
  })
}
