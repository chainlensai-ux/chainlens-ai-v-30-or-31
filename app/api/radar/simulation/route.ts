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

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const address = url.searchParams.get('address') ?? url.searchParams.get('contract') ?? ''
  const chain = url.searchParams.get('chain') ?? 'base'
  const liquidityUsd = num(url.searchParams.get('liquidityUsd'))
  const pairAddress = url.searchParams.has('pairAddress') ? url.searchParams.get('pairAddress') : undefined

  if (!VALID_ADDRESS.test(address)) {
    return NextResponse.json({ error: 'Invalid token address' }, { status: 400 })
  }

  const [security] = await Promise.all([
    fetchHoneypotSecurity(address, chain),
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
