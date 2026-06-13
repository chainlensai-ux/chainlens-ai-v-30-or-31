export type RadarSimulationStatus = 'passed' | 'open_check'

export type RadarSimulationOpenCheckReason =
  | 'insufficient_route'
  | 'missing_pair_address'
  | 'timeout_after_retry'
  | 'unsupported_pool_model'
  | 'provider_unavailable'
  | 'not_attempted_low_confidence_pair'

export interface RadarSimulationHoneypotInput {
  isHoneypot?: boolean | null
  buyTax?: number | null
  sellTax?: number | null
  simulationSuccess?: boolean | null
  failureReason?: RadarSimulationOpenCheckReason | null
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

const REASON_LABELS: Record<RadarSimulationOpenCheckReason, string> = {
  timeout_after_retry: 'Tax check timed out',
  unsupported_pool_model: 'Simulation unsupported',
  missing_pair_address: 'Pair route missing',
  insufficient_route: 'Route evidence missing',
  provider_unavailable: 'Simulation temporarily unavailable',
  not_attempted_low_confidence_pair: 'Simulation pending',
}

const REASON_CORTEX: Record<RadarSimulationOpenCheckReason, string> = {
  timeout_after_retry: 'Buy/sell simulation timed out after retry, so tax and honeypot status are not confirmed yet.',
  unsupported_pool_model: 'Simulation is not supported for this pool model yet.',
  missing_pair_address: 'Simulation could not run because the pair route is missing.',
  insufficient_route: 'Simulation could not run because route evidence is missing.',
  provider_unavailable: 'Simulation is temporarily unavailable; unresolved tokens are capped until checks complete.',
  not_attempted_low_confidence_pair: 'Simulation is pending until pair evidence has enough confidence.',
}

export function getRadarSimulationReasonLabel(reason: RadarSimulationOpenCheckReason | null | undefined): string {
  return reason ? REASON_LABELS[reason] ?? 'Simulation pending' : 'Tax check clear'
}

function openCheck(attempted: boolean, reason: RadarSimulationOpenCheckReason): RadarSimulationResult {
  return {
    attempted,
    status: 'open_check',
    buyTax: null,
    sellTax: null,
    isHoneypot: null,
    reason,
    label: REASON_LABELS[reason],
    cortexLine: REASON_CORTEX[reason],
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
    return openCheck(true, honeypot?.failureReason ?? 'provider_unavailable')
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
