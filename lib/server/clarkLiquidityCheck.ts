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
  technicalDebug: Record<string, unknown>
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
    lockBurnStatus: concentrated ? "not applicable (concentrated liquidity)" : lockStatus,
    controllerStatus: controller,
    exitRisk: normalizeExitRisk(typeof data.lpExitRisk === "string" ? data.lpExitRisk : null, liquidityUsd),
    poolAge: typeof data.poolAge === "string" ? data.poolAge : null,
    confidence: normalizeConfidence(typeof data.confidence === "string" ? data.confidence : null, missing, hasLiq),
    missingEvidence: missing,
    sourceLabels: ["liquidity-safety", "token-scanner-lp"],
    goodSigns: good,
    risks,
    verdict: verdictTextFor(status),
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

export function formatClarkLiquidityCheck(result: ClarkLiquidityCheckResult): string {
  const liq = formatUsdLiquidity(result.liquidityUsd)
  const good = result.goodSigns.length ? result.goodSigns.map((s) => `- ${s}`) : ["- none confirmed in this pass"]
  const risks = result.risks.length ? result.risks.map((s) => `- ${s}`) : ["- none confirmed in this pass"]
  const missing = result.missingEvidence.length ? result.missingEvidence.map((s) => `- ${s}`) : ["- none flagged"]
  const lockBurn = publicLockBurnLabel(result.lockBurnStatus, result.chainSlug)
  const controller = publicControllerLabel(result.controllerStatus, result.chainSlug)
  const poolAge = result.poolAge && String(result.poolAge).trim() ? result.poolAge : "unknown"
  return [
    `LIQUIDITY CHECK — ${result.symbol}`,
    `Chain: ${chainLabel(result.chainSlug)}`,
    `Liquidity: ${liq}`,
    `Primary pool: ${result.dexName ?? result.primaryPool ?? "not returned"}`,
    `Pool address: ${result.pairAddress ?? result.primaryPool ?? "not returned"}`,
    `LP model: ${result.lpModel ?? "unverified"}`,
    `LP lock/burn: ${lockBurn}`,
    `Controller: ${controller}`,
    `Pool age: ${poolAge}`,
    `Exit risk: ${result.exitRisk}`,
    `Confidence: ${result.confidence}`,
    "",
    "Good signs:",
    ...good,
    "",
    "Risks:",
    ...risks,
    "",
    "Missing LP evidence:",
    ...missing,
    "",
    "Verdict:",
    `- ${result.verdict}`,
    "",
    "CTA:",
    "- Open Token Scanner",
    "- Run full LP Safety",
    "- Add to Watchlist",
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
