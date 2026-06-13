export type RadarSimulationStatus = 'passed' | 'open_check'

export type RadarSimulationOpenCheckReason =
  | 'insufficient_route'
  | 'missing_pair_address'
  | 'timeout_after_retry'
  | 'unsupported_pool_model'
  | 'provider_unavailable'

export interface RadarSimulationHoneypotInput {
  isHoneypot?: boolean | null
  buyTax?: number | null
  sellTax?: number | null
  simulationSuccess?: boolean | null
}

export interface RadarSimulationInput {
  contract?: string | null
  liquidityUsd?: number | null
  /**
   * Pair/pool address backing the simulation route. Pass `null` when the
   * scan has pool/liquidity evidence but no resolved pair address — this is
   * distinct from omitting the field, which leaves existing callers (without
   * pair-address tracking) unaffected.
   */
  pairAddress?: string | null
  honeypot?: RadarSimulationHoneypotInput | null
}

export interface RadarSimulationResult {
  attempted: boolean
  status: RadarSimulationStatus
  buyTax: number | null
  sellTax: number | null
  isHoneypot: boolean | null
  reason: RadarSimulationOpenCheckReason | null
  label: string
  cortexLine: string
}

const VALID_ADDRESS = /^0x[a-fA-F0-9]{40}$/

function hasPoolEvidence(input: RadarSimulationInput): boolean {
  return typeof input.liquidityUsd === 'number' && Number.isFinite(input.liquidityUsd) && input.liquidityUsd > 0
}

function openCheck(attempted: boolean, reason: RadarSimulationOpenCheckReason): RadarSimulationResult {
  return {
    attempted,
    status: 'open_check',
    buyTax: null,
    sellTax: null,
    isHoneypot: null,
    reason,
    label: reason === 'timeout_after_retry' ? 'Simulation timed out after retry'
      : reason === 'unsupported_pool_model' ? 'Simulation unsupported for this pool'
        : reason === 'missing_pair_address' ? 'Pair route missing'
          : reason === 'provider_unavailable' ? 'Simulation pending'
            : 'Simulation pending',
    cortexLine: 'Buy/sell simulation could not complete, so tax and honeypot status are not confirmed yet.',
  }
}

/**
 * Decides whether Base Radar should attempt a buy/sell tax simulation and how
 * to present the result. Simulation is attempted only when the chain/token
 * address is valid and pool/liquidity evidence exists — callers should reuse
 * existing simulation/cache results (e.g. honeypot.is via getCachedHoneypot)
 * rather than issuing new provider calls.
 */
export function getRadarSimulationDisplay(input: RadarSimulationInput): RadarSimulationResult {
  const validAddress = typeof input.contract === 'string' && VALID_ADDRESS.test(input.contract)
  if (!validAddress || !hasPoolEvidence(input)) {
    return openCheck(false, 'insufficient_route')
  }

  if (input.pairAddress === null) {
    return openCheck(false, 'missing_pair_address')
  }

  const honeypot = input.honeypot
  if (!honeypot || honeypot.simulationSuccess == null) {
    return openCheck(true, 'timeout_after_retry')
  }

  if (honeypot.simulationSuccess === false) {
    return openCheck(true, 'unsupported_pool_model')
  }

  const buyTax = honeypot.buyTax ?? 0
  const sellTax = honeypot.sellTax ?? 0
  return {
    attempted: true,
    status: 'passed',
    buyTax,
    sellTax,
    isHoneypot: honeypot.isHoneypot ?? null,
    reason: null,
    label: `B ${buyTax.toFixed(1)}% / S ${sellTax.toFixed(1)}%`,
    cortexLine: 'Buy/sell simulation passed — values reflect the latest simulation result.',
  }
}
