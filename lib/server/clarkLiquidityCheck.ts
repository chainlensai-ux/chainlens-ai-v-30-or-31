// Clark liquidity check adapter — maps Token Scanner / liquidity-safety / Solana-native
// scanner evidence into one public-grade LP read. No provider calls live here; the caller
// injects fetches so tests stay offline and chain-strict.

export type ClarkLiquidityChain = "base" | "ethereum" | "robinhood" | "solana"

export type ClarkLiquidityStatus =
  | "verified"
  | "partial"
  | "risky"
  | "unsupported_proof"
  | "unavailable"
  | "ambiguous"
  | "needs_token"

export type ClarkLiquidityCheckResult = {
  status: ClarkLiquidityStatus
  chainSlug: ClarkLiquidityChain
  symbol: string
  tokenAddressOrMint: string
  liquidityUsd: number | null
  poolCount: number | null
  primaryPool: string | null
  dexName: string | null
  pairAddress: string | null
  lpModel: string | null
  lockBurnStatus: string
  controllerStatus: string
  exitRisk: "Low" | "Medium" | "High" | "Unverified"
  poolAge: string | null
  confidence: "High" | "Medium" | "Low"
  missingEvidence: string[]
  sourceLabels: string[]
  goodSigns: string[]
  risks: string[]
  verdict: string
  volume24hUsd?: number | null
  fdvUsd?: number | null
  marketCapUsd?: number | null
  lastUpdated?: string | null
  technicalDebug: Record<string, unknown>
}

export type ClarkLiquidityEntityType = "token_contract" | "lp_pair" | "wallet" | "unknown"

export type ClarkLiquidityRouteSelected =
  | "token_lp_module"
  | "pool_resolver"
  | "not_applicable"
  | "ask_chain"
  | "needs_token"

export type ClarkLiquidityRoutingAudit = {
  prompt: string
  parsedIntent: string
  address: string | null
  requestedChain: string | null
  hasContractCode: boolean | null
  resolvedEntityType: ClarkLiquidityEntityType | string
  routeSelected: ClarkLiquidityRouteSelected | string
  liquiditySourcesAttempted: string[]
  liquiditySourcesSucceeded: string[]
  liquidityUsd: number | null
  poolAddress: string | null
  dex: string | null
  cacheChainMatched: boolean
  notApplicableReason: string | null
}

export function resolveClarkLiquidityEntity(input: {
  hasContractCode: boolean | null
  isLpPair?: boolean | null
}): ClarkLiquidityEntityType {
  if (input.hasContractCode === false) return "wallet"
  if (input.hasContractCode === true && input.isLpPair === true) return "lp_pair"
  if (input.hasContractCode === true) return "token_contract"
  return "unknown"
}

export function inferLpPairFromPayload(
  data: Record<string, unknown> | null | undefined,
  queriedAddress: string,
): boolean {
  if (!data || !queriedAddress) return false
  const q = queriedAddress.toLowerCase()
  const meta = data.lpMeta && typeof data.lpMeta === "object" ? data.lpMeta as Record<string, unknown> : {}
  const pair = String(
    data.pairAddress ?? data.primaryPoolAddress ?? data.primaryPool ?? meta.primaryPoolAddress ?? "",
  ).toLowerCase()
  if (pair && pair === q) return true
  if (data.isPair === true || data.isLpPair === true || data.entityType === "lp_pair") return true
  const t0 = data.token0 ?? meta.token0
  const t1 = data.token1 ?? meta.token1
  return typeof t0 === "string" && typeof t1 === "string" && Boolean(t0) && Boolean(t1)
}

export function buildClarkLiquidityRoutingAudit(
  partial: Partial<ClarkLiquidityRoutingAudit> & Pick<ClarkLiquidityRoutingAudit, "prompt" | "parsedIntent">,
): ClarkLiquidityRoutingAudit {
  return {
    prompt: partial.prompt,
    parsedIntent: partial.parsedIntent,
    address: partial.address ?? null,
    requestedChain: partial.requestedChain ?? null,
    hasContractCode: partial.hasContractCode ?? null,
    resolvedEntityType: partial.resolvedEntityType ?? "unknown",
    routeSelected: partial.routeSelected ?? "needs_token",
    liquiditySourcesAttempted: partial.liquiditySourcesAttempted ?? [],
    liquiditySourcesSucceeded: partial.liquiditySourcesSucceeded ?? [],
    liquidityUsd: partial.liquidityUsd ?? null,
    poolAddress: partial.poolAddress ?? null,
    dex: partial.dex ?? null,
    cacheChainMatched: partial.cacheChainMatched ?? true,
    notApplicableReason: partial.notApplicableReason ?? null,
  }
}

export type ClarkLiquidityAnswerAudit = {
  prompt: string
  chainSlug: string
  address: string | null
  symbol: string | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  volumeLiquidityRatio: number | null
  marketCapUsd: number | null
  fdvUsd: number | null
  dex: string | null
  poolAddress: string | null
  poolAge: string | null
  verdict: string
  confidence: string
  sourcesUsed: string[]
  missingEvidence: string[]
}

export function volumeLiquidityRatio(volume24hUsd: number | null | undefined, liquidityUsd: number | null | undefined): number | null {
  if (volume24hUsd == null || liquidityUsd == null || !Number.isFinite(volume24hUsd) || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0) return null
  return volume24hUsd / liquidityUsd
}

export function buildClarkLiquidityAnswerAudit(
  partial: Partial<ClarkLiquidityAnswerAudit> & Pick<ClarkLiquidityAnswerAudit, "prompt" | "chainSlug">,
): ClarkLiquidityAnswerAudit {
  return {
    prompt: partial.prompt,
    chainSlug: partial.chainSlug,
    address: partial.address ?? null,
    symbol: partial.symbol ?? null,
    liquidityUsd: partial.liquidityUsd ?? null,
    volume24hUsd: partial.volume24hUsd ?? null,
    volumeLiquidityRatio: partial.volumeLiquidityRatio ?? null,
    marketCapUsd: partial.marketCapUsd ?? null,
    fdvUsd: partial.fdvUsd ?? null,
    dex: partial.dex ?? null,
    poolAddress: partial.poolAddress ?? null,
    poolAge: partial.poolAge ?? null,
    verdict: partial.verdict ?? "Partial",
    confidence: partial.confidence ?? "Low",
    sourcesUsed: partial.sourcesUsed ?? [],
    missingEvidence: partial.missingEvidence ?? [],
  }
}

export function liquidityAnswerAuditFromResult(prompt: string, result: ClarkLiquidityCheckResult): ClarkLiquidityAnswerAudit {
  return buildClarkLiquidityAnswerAudit({
    prompt,
    chainSlug: result.chainSlug,
    address: result.tokenAddressOrMint,
    symbol: result.symbol,
    liquidityUsd: result.liquidityUsd,
    volume24hUsd: result.volume24hUsd ?? null,
    volumeLiquidityRatio: volumeLiquidityRatio(result.volume24hUsd, result.liquidityUsd),
    marketCapUsd: result.marketCapUsd ?? null,
    fdvUsd: result.fdvUsd ?? null,
    dex: result.dexName,
    poolAddress: result.pairAddress ?? result.primaryPool,
    poolAge: result.poolAge,
    verdict: publicLiquidityVerdict(result),
    confidence: result.confidence,
    sourcesUsed: result.sourceLabels,
    missingEvidence: publicMissingEvidence(result),
  })
}

export type ClarkLiquidityCheckAudit = {
  prompt: string
  resolvedIntent: string
  symbolOrAddress: string | null
  selectedChain: string | null
  resolvedChain: string | null
  entityType: string
  resolverSource: string | null
  matchesCount: number
  ambiguityHandled: boolean
  scannerCalled: boolean
  liquidityStatus: string
  lpStatus: string
  cacheKey: string | null
  wrongChainCacheRejected: boolean
  responseStatus: string
}

export type ClarkLiquidityMatch = {
  address: string
  chainSlug: string
  symbol: string
  name?: string | null
  liquidityUsd?: number | null
}

const EVM_LOCK_WORDS = /\b(lock(?:ed)?|burn(?:ed)?|erc-?20\s+lp|lp\s+token)\b/i

export function clarkLiquidityCacheKey(chainSlug: string, tokenAddressOrMint: string): string {
  return `clarkLiquidity:${String(chainSlug).toLowerCase()}:${String(tokenAddressOrMint).toLowerCase()}`
}

export function rejectWrongChainLiquidityCache(
  cached: { chainSlug?: string | null; tokenAddressOrMint?: string | null } | null | undefined,
  want: { chainSlug: string; tokenAddressOrMint: string },
): boolean {
  if (!cached) return false
  const cChain = String(cached.chainSlug ?? "").toLowerCase()
  const cAddr = String(cached.tokenAddressOrMint ?? "").toLowerCase()
  const wChain = String(want.chainSlug).toLowerCase()
  const wAddr = String(want.tokenAddressOrMint).toLowerCase()
  if (!cChain || !cAddr) return true
  return cChain !== wChain || cAddr !== wAddr
}

export function formatUsdLiquidity(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "Unavailable"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function normalizeExitRisk(raw: string | null | undefined, liquidityUsd: number | null): "Low" | "Medium" | "High" | "Unverified" {
  const t = String(raw ?? "").toLowerCase()
  if (/\b(high|extreme|critical)\b/.test(t)) return "High"
  if (/\bmedium\b/.test(t)) return "Medium"
  if (/\blow\b/.test(t)) return "Low"
  if (liquidityUsd != null && liquidityUsd >= 1_000_000) return "Medium"
  if (liquidityUsd != null && liquidityUsd > 0) return "Unverified"
  return "Unverified"
}

function normalizeConfidence(raw: string | null | undefined, missing: string[], hasLiq: boolean): "High" | "Medium" | "Low" {
  const t = String(raw ?? "").toLowerCase()
  if (t === "high" && missing.length === 0 && hasLiq) return "High"
  if (t === "low" || missing.length >= 3 || !hasLiq) return "Low"
  if (t === "high" || t === "medium" || hasLiq) return "Medium"
  return "Low"
}

export function formatAmbiguousLiquiditySymbol(symbol: string, matches: ClarkLiquidityMatch[]): string {
  const labelChain = (chain: string): string => chain === "ethereum" || chain === "eth" ? "Ethereum" : chain === "solana" ? "Solana" : chain === "robinhood" ? "Robinhood" : chain === "base" ? "Base" : chain
  const unique = Array.from(new Map(matches
    .filter((m) => m.address)
    .map((m) => [`${m.chainSlug.toLowerCase()}:${m.address.toLowerCase()}`, m]))
    .values())
    .slice(0, 5)
  const choices = unique.map((m, index) => {
    const name = m.name && m.name.toUpperCase() !== m.symbol.toUpperCase() ? `${m.name} (${m.symbol})` : m.symbol
    const liquidity = m.liquidityUsd == null ? "liquidity not returned" : `liquidity ${formatUsdLiquidity(m.liquidityUsd)}`
    return `${index + 1}. ${name} — ${labelChain(m.chainSlug)} — ${m.address} — ${liquidity}`
  })
  return [
    `LIQUIDITY CHECK — ${symbol.toUpperCase()}`,
    `I found more than one ${symbol.toUpperCase()} match.`,
    "Choose one contract so I do not check the wrong token:",
    ...choices,
    "Paste the exact contract address you want checked.",
    "",
    "CTA: Run LP Check",
  ].join("\n")
}

export function formatNeedsTokenLiquidityReply(): string {
  return [
    "LP CHECK",
    "Liquidity Safety is the right Elite LP pipeline for that.",
    "Send a token contract and I will check pool model, lock/burn proof, controller/position verification, liquidity depth, exit risk, and missing proof.",
    "Or name a symbol (e.g. AERO) and chain: Base, Ethereum, Robinhood, or Solana.",
    "CTA: Run LP Check or Scan Token.",
  ].join("\n")
}

// VERDICT VOCABULARY, DISCLOSED (Clark liquidity structured-card task): the Verdict line must
// always read as one of the task's fixed words — "Liquidity verified / partial / risky /
// unsupported proof" — rather than the freeform sentences this used to carry per chain/branch
// ("Liquidity detected but exit risk is partial", "Solana AMM liquidity detected", etc.). The
// richer, chain-specific detail those sentences carried is not lost — it already lives in
// goodSigns/risks/missingEvidence, which the card prints separately. "unavailable" (no pool
// evidence returned at all) is not one of the four listed words but is kept as its own honest
// label rather than folded into "risky" — claiming directional risk from zero evidence would
// itself be a hidden-evidence violation of this task's own hard rules.
function verdictTextFor(status: ClarkLiquidityStatus): string {
  switch (status) {
    case "verified": return "Liquidity verified"
    case "partial": return "Liquidity partial"
    case "risky": return "Liquidity risky"
    case "unsupported_proof": return "Liquidity unsupported proof"
    case "unavailable": return "Liquidity unavailable"
    case "ambiguous": return "Liquidity check ambiguous — multiple tokens matched"
    case "needs_token": return "Liquidity check needs a token"
    default: return "Liquidity partial"
  }
}

function chainLabel(chain: ClarkLiquidityChain): string {
  if (chain === "ethereum") return "Ethereum"
  if (chain === "robinhood") return "Robinhood"
  if (chain === "solana") return "Solana"
  return "Base"
}

function applyRobinhoodWording(result: ClarkLiquidityCheckResult): ClarkLiquidityCheckResult {
  const missing = [...result.missingEvidence]
  const lock = "LP lock proof unsupported for this Robinhood pool model"
  const controller = "LP controller not verified"
  const exit = "Liquidity detected but exit risk is partial"
  if (!missing.some((m) => /lock proof unsupported/i.test(m))) missing.push(lock)
  if (!missing.some((m) => /controller not verified/i.test(m))) missing.push(controller)
  if (result.liquidityUsd != null && result.liquidityUsd > 0 && !missing.some((m) => /exit risk is partial/i.test(m))) {
    missing.push(exit)
  }
  return {
    ...result,
    lpModel: result.lpModel ?? "Robinhood pool model (partial)",
    lockBurnStatus: lock,
    controllerStatus: controller,
    exitRisk: result.liquidityUsd != null && result.liquidityUsd > 0 ? "Unverified" : result.exitRisk,
    missingEvidence: missing,
    status: result.liquidityUsd != null && result.liquidityUsd > 0 ? "unsupported_proof" : "partial",
    verdict: verdictTextFor(result.liquidityUsd != null && result.liquidityUsd > 0 ? "unsupported_proof" : "partial"),
    confidence: "Low",
  }
}

function applySolanaWording(result: ClarkLiquidityCheckResult): ClarkLiquidityCheckResult {
  const missing = result.missingEvidence.filter((m) => !EVM_LOCK_WORDS.test(m))
  if (!missing.some((m) => /not an evm-style check/i.test(m))) {
    missing.push("LP lock proof is not an EVM-style check on Solana")
  }
  if (!missing.some((m) => /control evidence/i.test(m))) {
    missing.push("Liquidity control evidence unavailable/partial")
  }
  const hasLiq = result.liquidityUsd != null && result.liquidityUsd > 0
  return {
    ...result,
    lpModel: result.lpModel ?? "Solana AMM",
    lockBurnStatus: "LP lock proof is not an EVM-style check on Solana",
    controllerStatus: result.controllerStatus && !EVM_LOCK_WORDS.test(result.controllerStatus)
      ? result.controllerStatus
      : "Liquidity control evidence unavailable/partial",
    missingEvidence: missing,
    goodSigns: [
      ...(hasLiq ? ["Solana AMM liquidity detected"] : []),
      ...result.goodSigns.filter((s) => !EVM_LOCK_WORDS.test(s)),
    ],
    risks: result.risks.filter((s) => !EVM_LOCK_WORDS.test(s)),
    status: hasLiq ? "partial" : "unavailable",
    verdict: verdictTextFor(hasLiq ? "partial" : "unavailable"),
  }
}

export function mapEvmLiquiditySafetyPayload(
  data: Record<string, unknown>,
  opts: { chainSlug: ClarkLiquidityChain; tokenAddressOrMint: string; symbol?: string | null },
): ClarkLiquidityCheckResult {
  const lpMeta = data.lpMeta && typeof data.lpMeta === "object" ? data.lpMeta as Record<string, unknown> : {}
  const gaps = Array.isArray(data.lp_evidence_gaps)
    ? (data.lp_evidence_gaps as Array<Record<string, unknown> | string>).map((g) => typeof g === "string" ? g : String(g.label ?? g.code ?? g.reason ?? "LP evidence gap"))
    : []
  const displayModel = typeof data.displayLpModel === "string" ? data.displayLpModel : (typeof data.poolModel === "string" ? data.poolModel : null)
  const concentrated = displayModel === "concentrated_liquidity" || displayModel === "concentrated" || data.lpProofApplicability === "not_applicable"
  const liquidityUsd = typeof data.lp_total_liquidity_usd === "number" ? data.lp_total_liquidity_usd : (typeof data.liquidityUsd === "number" ? data.liquidityUsd : null)
  const poolCount = typeof lpMeta.protocolPoolCandidatesCount === "number"
    ? lpMeta.protocolPoolCandidatesCount
    : (typeof data.poolCount === "number" ? data.poolCount : null)
  const primaryPool = typeof lpMeta.primaryPoolAddress === "string" ? lpMeta.primaryPoolAddress : (typeof data.primaryPoolAddress === "string" ? data.primaryPoolAddress : null)
  const dexName = typeof lpMeta.primaryPoolDex === "string" ? lpMeta.primaryPoolDex : (typeof data.dexName === "string" ? data.dexName : null)
  const lockStatus = typeof data.lpLockStatus === "string" ? data.lpLockStatus : "unverified"
  const controller = typeof data.lpController === "string" ? data.lpController : "not verified"
  const breakdown = Array.isArray(data.pool_breakdown) ? data.pool_breakdown as Array<Record<string, unknown>> : []
  const primaryRow = breakdown[0] ?? null
  const volume24hUsd = typeof primaryRow?.volume24h === "number"
    ? primaryRow.volume24h
    : (typeof data.volume24hUsd === "number" ? data.volume24hUsd : (typeof data.volume24h === "number" ? data.volume24h : null))
  const fdvUsd = typeof data.fdvUsd === "number" ? data.fdvUsd : (typeof data.fdv === "number" ? data.fdv : null)
  const marketCapUsd = typeof data.marketCapUsd === "number" ? data.marketCapUsd : (typeof data.marketCap === "number" ? data.marketCap : null)
  const missing = concentrated
    ? ["ERC-20 LP lock/burn proof does not apply to this concentrated pool model. Position/control verification is required.", ...gaps]
    : (gaps.length ? gaps : (liquidityUsd == null ? ["Liquidity depth not returned by pool sources"] : []))
  const good: string[] = []
  const risks: string[] = []
  if (liquidityUsd != null && liquidityUsd > 0) good.push(`Pool depth ${formatUsdLiquidity(liquidityUsd)} reported by pool sources`)
  if (concentrated) good.push("Concentrated-liquidity model identified — lock/burn is not claimed")
  if (lockStatus === "locked" || lockStatus === "burned") good.push(`Lock/burn status: ${lockStatus}`)
  if (lockStatus === "unlocked" || /wallet|team/i.test(controller)) risks.push(`Controller/lock status: ${controller} / ${lockStatus}`)
  if (liquidityUsd != null && liquidityUsd < 10_000) risks.push("Thin liquidity — exit risk can spike")
  const hasLiq = liquidityUsd != null && liquidityUsd > 0
  const status: ClarkLiquidityStatus = !hasLiq
    ? "unavailable"
    : /wallet|team|unlocked/i.test(`${controller} ${lockStatus}`)
      ? "risky"
      : concentrated
        ? "partial"
        : lockStatus === "locked" || lockStatus === "burned"
          ? "verified"
          : "partial"
  let result: ClarkLiquidityCheckResult = {
    status,
    chainSlug: opts.chainSlug,
    symbol: String(opts.symbol ?? data.symbol ?? "?").toUpperCase(),
    tokenAddressOrMint: opts.tokenAddressOrMint,
    liquidityUsd,
    poolCount,
    primaryPool,
    dexName,
    pairAddress: primaryPool,
    lpModel: displayModel ?? (typeof lpMeta.primaryPoolType === "string" ? String(lpMeta.primaryPoolType) : null),
    lockBurnStatus: concentrated ? "Concentrated pool — lock proof not applicable" : lockStatus,
    controllerStatus: controller,
    exitRisk: normalizeExitRisk(typeof data.lpExitRisk === "string" ? data.lpExitRisk : null, liquidityUsd),
    poolAge: typeof data.poolAge === "string" ? data.poolAge : null,
    confidence: normalizeConfidence(typeof data.confidence === "string" ? data.confidence : null, missing, hasLiq),
    missingEvidence: missing,
    sourceLabels: ["liquidity-safety", "token-scanner-lp"],
    goodSigns: good,
    risks,
    verdict: verdictTextFor(status),
    volume24hUsd,
    fdvUsd,
    marketCapUsd,
    lastUpdated: typeof data.updatedAt === "string" ? data.updatedAt : "live",
    technicalDebug: { displayModel, concentrated, lpLockStatus: lockStatus },
  }
  if (opts.chainSlug === "robinhood") result = applyRobinhoodWording(result)
  return result
}

export function mapSolanaLiquidityPayload(
  data: Record<string, unknown>,
  opts: { tokenAddressOrMint: string; symbol?: string | null },
): ClarkLiquidityCheckResult {
  const market = data.marketData && typeof data.marketData === "object" ? data.marketData as Record<string, unknown> : {}
  const pool = data.poolProgram && typeof data.poolProgram === "object" ? data.poolProgram as Record<string, unknown> : {}
  const liquidityUsd = typeof market.liquidityUsd === "number" ? market.liquidityUsd : null
  const dexName = typeof market.primaryDexLabel === "string" ? market.primaryDexLabel : (typeof pool.label === "string" ? pool.label : null)
  const primaryPool = typeof market.primaryPoolAddress === "string" ? market.primaryPoolAddress : (typeof pool.poolAddress === "string" ? pool.poolAddress : null)
  const gaps = Array.isArray(data.solanaEvidenceGaps) ? data.solanaEvidenceGaps.map(String) : []
  const unsupported = Array.isArray(data.unsupportedChecks)
    ? (data.unsupportedChecks as Array<Record<string, unknown> | string>).map((u) => typeof u === "string" ? u : String((u as Record<string, unknown>).check ?? u))
    : []
  const missing = [
    ...gaps,
    ...unsupported.filter((u) => /lp lock/i.test(u)),
  ]
  const result: ClarkLiquidityCheckResult = {
    status: liquidityUsd != null && liquidityUsd > 0 ? "partial" : "unavailable",
    chainSlug: "solana",
    symbol: String(opts.symbol ?? data.resolvedTokenSymbol ?? market.tokenSymbol ?? "?").toUpperCase(),
    tokenAddressOrMint: opts.tokenAddressOrMint,
    liquidityUsd,
    poolCount: primaryPool ? 1 : 0,
    primaryPool,
    dexName,
    pairAddress: primaryPool,
    lpModel: typeof pool.label === "string" ? `${pool.label} AMM` : "Solana AMM",
    lockBurnStatus: "LP lock proof is not an EVM-style check on Solana",
    controllerStatus: "Liquidity control evidence unavailable/partial",
    exitRisk: normalizeExitRisk(null, liquidityUsd),
    poolAge: typeof market.pairAgeLabel === "string" ? market.pairAgeLabel : null,
    confidence: liquidityUsd != null ? "Medium" : "Low",
    missingEvidence: missing,
    sourceLabels: ["solana-token-scanner"],
    goodSigns: [],
    risks: [],
    verdict: "",
    volume24hUsd: typeof market.volume24hUsd === "number" ? market.volume24hUsd : (typeof market.volume24h === "number" ? market.volume24h : null),
    fdvUsd: typeof market.fdvUsd === "number" ? market.fdvUsd : null,
    marketCapUsd: typeof market.marketCapUsd === "number" ? market.marketCapUsd : null,
    lastUpdated: "live",
    technicalDebug: { poolLabel: pool.label ?? null, poolVerdict: pool.verdict ?? null },
  }
  return applySolanaWording(result)
}

function publicLockBurnLabel(status: string, chain: ClarkLiquidityChain): string {
  const t = String(status ?? "").toLowerCase()
  if (chain === "solana" || chain === "robinhood") return "unsupported"
  if (/\bnot applicable\b/.test(t)) return "not confirmed"
  if ((/\b(locked|burned)\b/.test(t)) && !/unverified|not confirmed|unsupported|not returned|not an evm/.test(t)) return "verified"
  if (/unsupported/.test(t)) return "unsupported"
  return "not confirmed"
}

function publicControllerLabel(status: string, chain: ClarkLiquidityChain): string {
  const t = String(status ?? "").toLowerCase()
  if (chain === "solana" || chain === "robinhood") return "unsupported"
  if (/unsupported/.test(t)) return "unsupported"
  if (/\b(not verified|unverified|not returned|unavailable|partial|open check)\b/.test(t)) return "not verified"
  if (/\b(protocol|burn|renounced|verified|locked)\b/.test(t)) return "verified"
  return "not verified"
}

export function publicLiquidityVerdict(result: ClarkLiquidityCheckResult): "Strong" | "Decent" | "Thin" | "Risky" | "Partial" {
  const liq = result.liquidityUsd
  if (result.status === "risky") return "Risky"
  if (liq == null || !Number.isFinite(liq) || liq <= 0) return result.status === "unavailable" ? "Thin" : "Partial"
  if (liq < 10_000) return "Thin"
  if (result.status === "verified" && liq >= 250_000 && result.exitRisk === "Low") return "Strong"
  if (liq >= 50_000 && result.status !== "unavailable") return "Decent"
  return "Partial"
}

function formatVolumeLiquidityRatio(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return "Unavailable"
  if (ratio >= 10) return `${ratio.toFixed(1)}x`
  return `${ratio.toFixed(2)}x`
}

function isConcentratedPool(result: ClarkLiquidityCheckResult): boolean {
  const model = `${result.lpModel ?? ""} ${result.lockBurnStatus ?? ""}`.toLowerCase()
  return /concentrated|v3|not applicable/.test(model)
}

export function publicMissingEvidence(result: ClarkLiquidityCheckResult): string[] {
  const out: string[] = []
  const push = (item: string) => {
    if (!out.some((x) => x.toLowerCase() === item.toLowerCase())) out.push(item)
  }
  const lock = `${result.lockBurnStatus ?? ""} ${result.controllerStatus ?? ""}`.toLowerCase()
  if (result.chainSlug === "solana" || result.chainSlug === "robinhood" || /unsupported|not verified|unverified|not an evm|not applicable|partial|unavailable/.test(lock)) {
    push("LP/control not verified")
  }
  if (!result.poolAge || result.poolAge === "unknown") push("Pool age missing")
  if (!result.missingEvidence.some((m) => /holder|creator|deployer|authority/i.test(m))) {
    push(result.chainSlug === "solana" ? "Holder/creator missing" : "Holder/deployer missing")
  }
  if (!result.missingEvidence.some((m) => /security|simulation|honeypot/i.test(m))) {
    push("Security simulation missing")
  }
  for (const m of result.missingEvidence) {
    if (/erc-20|honeypot tax|contract verified/i.test(m) && (result.chainSlug === "solana" || result.chainSlug === "robinhood")) continue
    push(m)
  }
  return out
}

export function explainLiquidityMeaning(result: ClarkLiquidityCheckResult): string {
  const liq = result.liquidityUsd
  const vol = result.volume24hUsd ?? null
  const liqLabel = formatUsdLiquidity(liq)
  const ratio = volumeLiquidityRatio(vol, liq)
  const parts: string[] = []
  if (liq == null || liq <= 0) {
    parts.push("No usable pool liquidity was returned, so this cannot be called strong.")
  } else if (liq < 10_000) {
    parts.push(`Liquidity is ${liqLabel}. That is thin — even small trades can move the price, and exit risk is high.`)
  } else if (liq < 75_000) {
    parts.push(`Liquidity is ${liqLabel}. That is enough for small trades, but not deep enough for large entries without slippage risk.`)
  } else if (liq < 250_000) {
    parts.push(`Liquidity is ${liqLabel}. Normal-size trades should clear, but large exits can still move the pool.`)
  } else {
    parts.push(`Liquidity is ${liqLabel}. Depth is enough for most normal traders, though large size still depends on the pool model and 24h volume.`)
  }
  if (liq && liq > 0 && ratio != null) {
    if (ratio >= 2) parts.push("24h volume is healthy compared with liquidity.")
    else if (ratio >= 0.5) parts.push("24h volume is moderate compared with liquidity.")
    else parts.push("24h volume is light compared with liquidity, so turnover is weaker than the depth suggests.")
  } else if (liq && liq > 0) {
    parts.push("24h volume was not returned, so turnover versus depth cannot be confirmed.")
  }
  if (result.chainSlug === "solana") {
    parts.push(`This is a Solana AMM. EVM-style lock/burn proof does not apply. Exit risk is ${result.exitRisk.toLowerCase()} on pool liquidity and unverified LP/control evidence.`)
  } else if (result.chainSlug === "robinhood") {
    parts.push("Robinhood pool models do not have EVM-style LP lock proof, so exit risk stays partial even when liquidity exists.")
  } else if (isConcentratedPool(result)) {
    parts.push("This is a concentrated pool, not a locked LP token. Lock/burn proof is not applicable; exit risk follows positions and depth, not a burned LP token.")
  } else if ((/locked|burned/.test(String(result.lockBurnStatus).toLowerCase())) && result.status === "verified") {
    parts.push("LP lock/burn evidence is verified, which lowers rug-pull exit risk relative to an unlocked pool.")
  } else {
    parts.push(`Exit risk is ${result.exitRisk.toLowerCase()} on current evidence — LP/control is not fully verified.`)
  }
  return parts.slice(0, 3).join(" ")
}

function poolModelLabel(result: ClarkLiquidityCheckResult): string {
  if (result.chainSlug === "solana") return result.lpModel && /amm/i.test(result.lpModel) ? result.lpModel : "Solana AMM"
  if (result.chainSlug === "robinhood") return result.lpModel ?? "Robinhood pool model (partial)"
  if (isConcentratedPool(result)) return result.lpModel ?? "concentrated"
  return result.lpModel ?? "unverified"
}

function publicVerdictLine(result: ClarkLiquidityCheckResult): string {
  const verdict = publicLiquidityVerdict(result)
  if (result.status === "verified" && verdict === "Strong") return "Strong"
  if (result.confidence === "Low" || result.status === "partial" || result.status === "unsupported_proof") {
    return `${verdict} but not fully verified`
  }
  return verdict
}

function strengthFollowupLead(result: ClarkLiquidityCheckResult): string {
  const verdict = publicLiquidityVerdict(result)
  if (verdict === "Strong") return "Yes — liquidity looks strong on current pool depth."
  if (verdict === "Decent") return "Not fully — liquidity is decent, not strong."
  if (verdict === "Thin") return "No — liquidity is thin."
  if (verdict === "Risky") return "No — liquidity is risky."
  return "Not fully — liquidity evidence is only partial."
}

/** Follow-ups like "is liquidity strong?" — not /lp, not a first scan. */
export function isLiquidityStrengthFollowupPrompt(prompt: string): boolean {
  const t = String(prompt ?? "").trim()
  if (!t || /^\/lp\b/i.test(t)) return false
  return /\b(is\s+(?:the\s+|this\s+|that\s+)?liquidity\s+strong|is\s+that\s+enough\s+liquidity|is\s+(?:the\s+|this\s+)?liquidity\s+(?:good|ok|decent|thin|deep|weak|enough)|how\s+strong\s+is\s+(?:the\s+|this\s+)?liquidity|liquidity\s+strong(?:\s+enough)?|enough\s+liquidity)\b/i.test(t)
}

/** Follow-ups like "is LP locked?" / "explain LP" — not /lp, not "run LP check". */
export function isLiquidityLockFollowupPrompt(prompt: string): boolean {
  const t = String(prompt ?? "").trim()
  if (!t || /^\/lp\b/i.test(t)) return false
  if (isLiquidityStrengthFollowupPrompt(t)) return false
  return /\b(is\s+(?:the\s+|this\s+|that\s+)?(?:lp|liquidity)\s+locked|is\s+it\s+locked|is\s+(?:the\s+|this\s+)?(?:lp|liquidity)\s+burned|lock\s+proof|burn\s+proof|explain\s+(?:the\s+)?(?:lp|liquidity)|can\s+(?:the\s+)?(?:lp|liquidity)\s+be\s+pulled|who\s+controls\s+(?:the\s+)?(?:lp|liquidity))\b/i.test(t)
}

function lockFollowupLead(result: ClarkLiquidityCheckResult): string {
  if (result.chainSlug === "solana") {
    return "Not as an EVM LP lock. Solana AMM liquidity has no ERC-20 lock/burn proof in this engine."
  }
  if (result.chainSlug === "robinhood") {
    return "Not as an EVM LP lock. Robinhood pool models do not have ERC-20 LP lock/burn proof."
  }
  if (isConcentratedPool(result)) {
    return "Not applicable — this is a concentrated pool, not a locked LP token."
  }
  const lock = publicLockBurnLabel(result.lockBurnStatus, result.chainSlug)
  const t = `${result.lockBurnStatus ?? ""} ${result.controllerStatus ?? ""}`.toLowerCase()
  if (lock === "verified" || ((/locked|burned/.test(t)) && result.status === "verified" && !/unverified|not confirmed|unsupported/.test(t))) {
    return "Yes — LP lock/burn proof is verified on current evidence."
  }
  if (/wallet[_\s-]?controlled|team[_\s-]?controlled/.test(t)) {
    return "No — LP appears wallet/team controlled, not locked."
  }
  if (result.status === "unavailable") {
    return "Not confirmed — liquidity/LP evidence was not returned."
  }
  return "Not confirmed — LP lock/burn proof was not verified in this pass."
}

export function formatClarkLiquidityCheck(result: ClarkLiquidityCheckResult): string {
  const liq = formatUsdLiquidity(result.liquidityUsd)
  const vol = formatUsdLiquidity(result.volume24hUsd ?? null)
  const ratio = formatVolumeLiquidityRatio(volumeLiquidityRatio(result.volume24hUsd, result.liquidityUsd))
  const mcap = result.marketCapUsd != null ? formatUsdLiquidity(result.marketCapUsd) : "Unavailable"
  const fdv = result.fdvUsd != null ? formatUsdLiquidity(result.fdvUsd) : (result.marketCapUsd != null ? formatUsdLiquidity(result.marketCapUsd) : "Unavailable")
  const good = result.goodSigns.length ? result.goodSigns.map((s) => `- ${s}`) : ["- none confirmed in this pass"]
  const risks = result.risks.length ? result.risks.map((s) => `- ${s}`) : ["- none confirmed in this pass"]
  const missing = publicMissingEvidence(result).map((s) => `- ${s}`)
  const lockBurn = publicLockBurnLabel(result.lockBurnStatus, result.chainSlug)
  const controller = publicControllerLabel(result.controllerStatus, result.chainSlug)
  const poolAge = result.poolAge && String(result.poolAge).trim() ? result.poolAge : "unknown"
  const evidence = result.sourceLabels.length ? result.sourceLabels.join(" + ") : (result.chainSlug === "solana" ? "Solana Token Scanner market/pool module" : "Token Scanner LP module")
  const lpStatus = result.chainSlug === "solana" || result.chainSlug === "robinhood"
    ? result.lockBurnStatus
    : (result.lockBurnStatus || "unverified")
  const dexLabel = result.dexName ?? (result.chainSlug === "solana" ? "unverified DEX/pool source" : "unverified")
  const poolAddr = result.pairAddress ?? result.primaryPool ?? "not returned"
  const nextCreator = result.chainSlug === "solana" ? "Check Creator" : "Check Deployer"
  const lpControlLine = result.chainSlug === "solana"
    ? `LP/control evidence: ${result.controllerStatus || "unavailable/partial"}`
    : `LP lock/burn: ${lockBurn}`
  return [
    `LIQUIDITY CHECK — ${result.symbol}`,
    `Verdict: ${publicVerdictLine(result)}`,
    "",
    "Meaning:",
    explainLiquidityMeaning(result),
    "",
    "Key metrics:",
    `- Liquidity: ${liq}`,
    `- 24h Volume: ${vol}`,
    `- Volume/liquidity ratio: ${ratio}`,
    `- Market cap: ${mcap}`,
    `- FDV: ${fdv}`,
    `- Chain: ${chainLabel(result.chainSlug)}`,
    `- DEX: ${dexLabel}`,
    `- DEX / pool source: ${dexLabel}`,
    `- Pool: ${poolAddr}`,
    `- Primary pool: ${result.primaryPool ?? result.dexName ?? "not returned"}`,
    `- Pool address: ${poolAddr}`,
    `- Pool age: ${poolAge}`,
    `- LP model: ${poolModelLabel(result)}`,
    `- ${lpControlLine}`,
    `- LP Status: ${lpStatus}`,
    `- Controller: ${controller}`,
    `- Exit risk: ${result.exitRisk}`,
    `- Confidence: ${result.confidence}`,
    `- Evidence: ${evidence}`,
    `- Updated: ${result.lastUpdated ?? "live"}`,
    "",
    "Good signs:",
    ...good,
    "",
    "Risks:",
    ...risks,
    "",
    "Missing evidence:",
    ...missing,
    "",
    `Verdict: ${verdictTextFor(result.status)}`,
    "",
    "Next:",
    "- Deep Scan Token",
    "- Check LP",
    "- Check Holders",
    `- ${nextCreator}`,
    "- Add to Watchlist",
    "- Open Token Scanner",
  ].join("\n")
}

/** Direct answer for "is liquidity strong?" — same evidence as the full LP card, not a second scan. */
export function formatClarkLiquidityFollowup(result: ClarkLiquidityCheckResult): string {
  const liq = formatUsdLiquidity(result.liquidityUsd)
  const vol = formatUsdLiquidity(result.volume24hUsd ?? null)
  const ratio = formatVolumeLiquidityRatio(volumeLiquidityRatio(result.volume24hUsd, result.liquidityUsd))
  const missing = publicMissingEvidence(result).slice(0, 4).map((s) => `- ${s}`)
  const lockBurn = publicLockBurnLabel(result.lockBurnStatus, result.chainSlug)
  const lpControl = result.chainSlug === "solana" || result.chainSlug === "robinhood"
    ? (result.lockBurnStatus || "unsupported")
    : lockBurn
  const poolAddr = result.pairAddress ?? result.primaryPool
  const nextCreator = result.chainSlug === "solana" ? "Check Creator" : "Check Deployer"
  const risks = result.risks.slice(0, 3).map((s) => `- ${s}`)
  return [
    `LIQUIDITY READ — ${result.symbol}`,
    `Is liquidity strong? ${strengthFollowupLead(result)}`,
    `Verdict: ${publicVerdictLine(result)}`,
    "",
    "Why:",
    explainLiquidityMeaning(result),
    "",
    "Key numbers:",
    `- Liquidity: ${liq}`,
    `- 24h Volume: ${vol}`,
    `- Volume/liquidity ratio: ${ratio}`,
    `- Chain: ${chainLabel(result.chainSlug)}`,
    `- DEX: ${result.dexName ?? "unverified"}`,
    ...(poolAddr ? [`- Pool address: ${poolAddr}`] : []),
    `- Pool age: ${result.poolAge && String(result.poolAge).trim() ? result.poolAge : "unknown"}`,
    `- LP/control: ${lpControl}`,
    `- Exit risk: ${result.exitRisk}`,
    `- Confidence: ${result.confidence}`,
    ...(risks.length ? ["", "Risks:", ...risks] : []),
    "",
    "Missing evidence:",
    ...missing,
    "",
    "Next:",
    "- Deep Scan Token",
    "- Check LP",
    `- ${nextCreator}`,
    "- Open Token Scanner",
  ].join("\n")
}

/** Direct answer for "is LP locked?" / "explain LP" — same evidence as the full LP card, not a second scan. */
export function formatClarkLiquidityLockFollowup(result: ClarkLiquidityCheckResult): string {
  const liq = formatUsdLiquidity(result.liquidityUsd)
  const missing = publicMissingEvidence(result).slice(0, 4).map((s) => `- ${s}`)
  const lockBurn = publicLockBurnLabel(result.lockBurnStatus, result.chainSlug)
  const lpControl = result.chainSlug === "solana" || result.chainSlug === "robinhood"
    ? (result.lockBurnStatus || "unsupported")
    : lockBurn
  const controller = publicControllerLabel(result.controllerStatus, result.chainSlug)
  const poolAddr = result.pairAddress ?? result.primaryPool
  const nextCreator = result.chainSlug === "solana" ? "Check Creator" : "Check Deployer"
  const risks = result.risks.slice(0, 3).map((s) => `- ${s}`)
  const why = (() => {
    if (result.chainSlug === "solana") {
      return "Solana uses AMM pool liquidity, not an ERC-20 LP token that can be locked or burned. Control/lock proof stays unsupported here."
    }
    if (result.chainSlug === "robinhood") {
      return "Robinhood pool models do not expose EVM-style LP lock/burn proof, so lock status cannot be confirmed from this engine."
    }
    if (isConcentratedPool(result)) {
      return "Concentrated liquidity does not mint a standard LP token. Exit risk follows positions and depth, not a burned LP token."
    }
    if (lpControl === "verified") {
      return "Lock/burn evidence is verified, which lowers rug-pull exit risk relative to an unlocked pool. Depth still matters for exits."
    }
    return `LP/control is ${lpControl}. Exit risk is ${result.exitRisk.toLowerCase()} on current evidence — do not treat unverified lock as locked.`
  })()
  return [
    `LP LOCK READ — ${result.symbol}`,
    `Is LP locked? ${lockFollowupLead(result)}`,
    `Verdict: ${publicVerdictLine(result)}`,
    "",
    "Why:",
    why,
    "",
    "Key numbers:",
    `- Liquidity: ${liq}`,
    `- Chain: ${chainLabel(result.chainSlug)}`,
    `- DEX: ${result.dexName ?? "unverified"}`,
    ...(poolAddr ? [`- Pool address: ${poolAddr}`] : []),
    `- LP model: ${poolModelLabel(result)}`,
    `- LP/control: ${lpControl}`,
    `- Controller: ${controller}`,
    `- Exit risk: ${result.exitRisk}`,
    `- Confidence: ${result.confidence}`,
    ...(risks.length ? ["", "Risks:", ...risks] : []),
    "",
    "Missing evidence:",
    ...missing,
    "",
    "Next:",
    "- Deep Scan Token",
    "- Check LP",
    `- ${nextCreator}`,
    "- Open Token Scanner",
  ].join("\n")
}

export function formatUnknownLiquidityEntityReply(): string {
  return [
    "LIQUIDITY CHECK",
    "I couldn't confirm whether this is a token contract, an LP/pool, or a wallet.",
    "Tell me the chain — Base, Ethereum, Robinhood, or Solana — or paste a token contract.",
    "",
    "CTA: Open Token Scanner",
  ].join("\n")
}

export function buildClarkLiquidityCheckAudit(partial: Partial<ClarkLiquidityCheckAudit> & Pick<ClarkLiquidityCheckAudit, "prompt" | "resolvedIntent">): ClarkLiquidityCheckAudit {
  return {
    prompt: partial.prompt,
    resolvedIntent: partial.resolvedIntent,
    symbolOrAddress: partial.symbolOrAddress ?? null,
    selectedChain: partial.selectedChain ?? null,
    resolvedChain: partial.resolvedChain ?? null,
    entityType: partial.entityType ?? "unknown",
    resolverSource: partial.resolverSource ?? null,
    matchesCount: partial.matchesCount ?? 0,
    ambiguityHandled: partial.ambiguityHandled ?? false,
    scannerCalled: partial.scannerCalled ?? false,
    liquidityStatus: partial.liquidityStatus ?? "not_run",
    lpStatus: partial.lpStatus ?? "not_run",
    cacheKey: partial.cacheKey ?? null,
    wrongChainCacheRejected: partial.wrongChainCacheRejected ?? false,
    responseStatus: partial.responseStatus ?? "pending",
  }
}

export async function runClarkLiquidityCheck(opts: {
  chainSlug: ClarkLiquidityChain
  chainId?: number | null
  tokenAddressOrMint: string
  symbol?: string | null
  source: "clark"
  cached?: ClarkLiquidityCheckResult | null
}, deps: {
  fetchEvmLiquidity: (tokenAddress: string, chain: "base" | "eth" | "robinhood") => Promise<Record<string, unknown> | null>
  fetchSolanaLiquidity: (mint: string) => Promise<Record<string, unknown> | null>
}): Promise<ClarkLiquidityCheckResult> {
  const want = { chainSlug: opts.chainSlug, tokenAddressOrMint: opts.tokenAddressOrMint }
  if (opts.cached && !rejectWrongChainLiquidityCache(opts.cached, want)) {
    return opts.cached
  }
  if (opts.chainSlug === "solana") {
    const payload = await deps.fetchSolanaLiquidity(opts.tokenAddressOrMint)
    if (!payload) {
      return applySolanaWording({
        status: "unavailable",
        chainSlug: "solana",
        symbol: String(opts.symbol ?? "?").toUpperCase(),
        tokenAddressOrMint: opts.tokenAddressOrMint,
        liquidityUsd: null,
        poolCount: null,
        primaryPool: null,
        dexName: null,
        pairAddress: null,
        lpModel: "Solana AMM",
        lockBurnStatus: "LP lock proof is not an EVM-style check on Solana",
        controllerStatus: "Liquidity control evidence unavailable/partial",
        exitRisk: "Unverified",
        poolAge: null,
        confidence: "Low",
        missingEvidence: ["Solana AMM liquidity not returned"],
        sourceLabels: ["solana-token-scanner"],
        goodSigns: [],
        risks: [],
        verdict: verdictTextFor("unavailable"),
        technicalDebug: { reason: "solana_payload_empty" },
      })
    }
    return mapSolanaLiquidityPayload(payload, { tokenAddressOrMint: opts.tokenAddressOrMint, symbol: opts.symbol })
  }
  const evmChain = opts.chainSlug === "ethereum" ? "eth" : opts.chainSlug
  const payload = await deps.fetchEvmLiquidity(opts.tokenAddressOrMint, evmChain)
  if (!payload) {
    return {
      status: "unavailable",
      chainSlug: opts.chainSlug,
      symbol: String(opts.symbol ?? "?").toUpperCase(),
      tokenAddressOrMint: opts.tokenAddressOrMint,
      liquidityUsd: null,
      poolCount: null,
      primaryPool: null,
      dexName: null,
      pairAddress: null,
      lpModel: null,
      lockBurnStatus: "not returned",
      controllerStatus: "not returned",
      exitRisk: "Unverified",
      poolAge: null,
      confidence: "Low",
      missingEvidence: ["Liquidity pipeline did not return a usable result for this contract"],
      sourceLabels: ["liquidity-safety"],
      goodSigns: [],
      risks: [],
      verdict: verdictTextFor("unavailable"),
      technicalDebug: { reason: "evm_payload_empty" },
    }
  }
  return mapEvmLiquiditySafetyPayload(payload, {
    chainSlug: opts.chainSlug,
    tokenAddressOrMint: opts.tokenAddressOrMint,
    symbol: opts.symbol,
  })
}
