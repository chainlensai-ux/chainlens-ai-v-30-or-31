// TOKEN SCANNER PIPELINE AUDIT — compact receipt for one scan request.
// Built from already-computed evidence. Never fabricates LP/sim/holder/deployer facts.

export const TOKEN_SCANNER_RISK_SCORE_SOURCE = 'lib/server/riskScore.calculateTokenRiskScore'

export type TokenScannerPipelineAudit = {
  requestId: string | null
  chainSlug: string
  chainId: number | null
  tokenAddress: string
  inputType: string
  resolverSource: string | null
  tickerResolution: string | null
  selectedPool: string | null
  marketSourcesTried: string[]
  marketSource: string | null
  marketStatus: string | null
  simulationAttempted: boolean
  simulationProvider: string | null
  simulationSource: string | null
  simulationStatus: string | null
  holdersSource: string | null
  holderSource: string | null
  holderCount: number | null
  holderCountReason: string | null
  devResolved: boolean
  supplyControlStatus: string | null
  clusterStatus: string | null
  lpProtocol: string | null
  lpModel: string | null
  lpProofPath: string | null
  lpSource: string | null
  lpStatus: string | null
  positionProofAttempted: boolean
  positionProofStatus: string | null
  rpcAttempted: boolean
  proofAttempted: boolean
  finalLpModel: string | null
  finalLpStatus: string | null
  finalSimStatus: string | null
  riskInputsUsed: string[]
  riskScore: number | null
  riskScoreSource: string
  finalRiskScore: number | null
  cortexTokenAddress: string
  cortexChainId: number | null
  cacheKey: string
  cacheHit: boolean
  cacheChainMatched: boolean
  skipCache: boolean
  staleResponseIgnored: boolean
  firstFailureStage: string | null
  exactFailureReason: string | null
}

export type TokenScannerPipelineAuditInput = {
  requestId?: string | null
  chainSlug: string
  chainId: number | null
  tokenAddress: string
  inputType?: string | null
  resolverSource?: string | null
  tickerResolution?: string | null
  selectedPool?: string | null
  marketSourcesTried?: string[]
  marketSource?: string | null
  marketStatus?: string | null
  simulationAttempted?: boolean
  simulationProvider?: string | null
  simulationStatus?: string | null
  holdersSource?: string | null
  holderCount?: number | null
  holderCountReason?: string | null
  devResolved?: boolean
  supplyControlStatus?: string | null
  clusterStatus?: string | null
  lpProtocol?: string | null
  lpModel?: string | null
  lpProofPath?: string | null
  lpSource?: string | null
  lpStatus?: string | null
  positionProofAttempted?: boolean
  positionProofStatus?: string | null
  rpcAttempted?: boolean
  proofAttempted?: boolean
  riskInputsUsed?: string[]
  riskScore?: number | null
  cacheKey: string
  cacheHit?: boolean
  cacheChainMatched?: boolean
  skipCache?: boolean
  staleResponseIgnored?: boolean
  firstFailureStage?: string | null
  exactFailureReason?: string | null
}

export function cortexIdentityMatchesScanner(audit: Pick<TokenScannerPipelineAudit, 'tokenAddress' | 'chainId' | 'cortexTokenAddress' | 'cortexChainId'>): boolean {
  return audit.cortexTokenAddress.toLowerCase() === audit.tokenAddress.toLowerCase()
    && audit.cortexChainId === audit.chainId
}

export function buildTokenScannerPipelineAudit(input: TokenScannerPipelineAuditInput): TokenScannerPipelineAudit {
  const tokenAddress = (input.tokenAddress || '').toLowerCase()
  const chainId = input.chainId ?? null
  return {
    requestId: input.requestId ?? null,
    chainSlug: input.chainSlug,
    chainId,
    tokenAddress,
    inputType: input.inputType ?? 'unknown',
    resolverSource: input.resolverSource ?? null,
    tickerResolution: input.tickerResolution ?? input.resolverSource ?? null,
    selectedPool: input.selectedPool ?? null,
    marketSourcesTried: input.marketSourcesTried ?? [],
    marketSource: input.marketSource ?? null,
    marketStatus: input.marketStatus ?? null,
    simulationAttempted: Boolean(input.simulationAttempted),
    simulationProvider: input.simulationProvider ?? null,
    simulationSource: input.simulationProvider ?? null,
    simulationStatus: input.simulationStatus ?? null,
    holdersSource: input.holdersSource ?? null,
    holderSource: input.holdersSource ?? null,
    holderCount: input.holderCount ?? null,
    holderCountReason: input.holderCountReason ?? null,
    devResolved: Boolean(input.devResolved),
    supplyControlStatus: input.supplyControlStatus ?? null,
    clusterStatus: input.clusterStatus ?? null,
    lpProtocol: input.lpProtocol ?? null,
    lpModel: input.lpModel ?? null,
    lpProofPath: input.lpProofPath ?? null,
    lpSource: input.lpSource ?? null,
    lpStatus: input.lpStatus ?? null,
    positionProofAttempted: Boolean(input.positionProofAttempted),
    positionProofStatus: input.positionProofStatus ?? null,
    rpcAttempted: Boolean(input.rpcAttempted),
    proofAttempted: Boolean(input.proofAttempted),
    finalLpModel: input.lpModel ?? null,
    finalLpStatus: input.lpStatus ?? null,
    finalSimStatus: input.simulationStatus ?? null,
    riskInputsUsed: input.riskInputsUsed ?? [],
    riskScore: input.riskScore ?? null,
    riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE,
    finalRiskScore: input.riskScore ?? null,
    cortexTokenAddress: tokenAddress,
    cortexChainId: chainId,
    cacheKey: input.cacheKey,
    cacheHit: Boolean(input.cacheHit),
    cacheChainMatched: input.cacheChainMatched !== false,
    skipCache: Boolean(input.skipCache),
    staleResponseIgnored: Boolean(input.staleResponseIgnored),
    firstFailureStage: input.firstFailureStage ?? null,
    exactFailureReason: input.exactFailureReason ?? null,
  }
}
