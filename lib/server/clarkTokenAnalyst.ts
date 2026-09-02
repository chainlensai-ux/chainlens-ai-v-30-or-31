// Elite Clark token Q&A — same Token Scanner state the UI shows, never a parallel story.
// Answers stay short: Verdict, Key reasons, Verified evidence, Missing/unsupported, Next action.
// Missing data is never treated as safe. This is a risk read, not financial advice.

import { normalizeRiskScore, type CanonicalRiskLabel } from "../riskScoreDirection.ts"
import type { TokenScanEvidence } from "./clarkRouting.ts"
import { computeClarkTokenVerdictCore, buildClarkTokenVerdictInputFromEvidence, hasUsableTokenEvidence } from "./clarkRouting.ts"

export type ClarkTokenAnalystTopic =
  | "safe"
  | "risk"
  | "lp"
  | "holders"
  | "supply"
  | "dev"
  | "sell"
  | "taxes"
  | "pumping"
  | "red_flags"
  | "good_signs"
  | "next"
  | "explain_lp"
  | "explain_holders"
  | "explain_dev"
  | "explain_risk"
  | "explain_market"

export type ClarkTokenAnalystChainFamily = "solana" | "robinhood" | "evm"

export type ClarkTokenAnalystSnapshot = {
  chain: string
  family: ClarkTokenAnalystChainFamily
  symbol: string
  address: string | null
  riskScore: number | null
  riskLabel: CanonicalRiskLabel | null
  liquidityUsd: number | null
  volume24h: number | null
  change24h: number | null
  marketCap: number | null
  top1Pct: number | null
  top10Pct: number | null
  holderCount: number | null
  holdersVerified: boolean
  marketVerified: boolean
  lpStatus: string | null
  lpPoolType: string | null
  lpProofStatus: string | null
  lpPositionProof: string | null
  lpConcentrated: boolean
  lpVerified: boolean
  /** From concentratedLpPositionOwnershipAudit.finalStatus (lib/server/lpProof.ts) — the single
   * source of truth for concentrated-pool ownership state, never re-derived here. */
  lpPositionOwnershipFinalStatus: string | null
  lpPositionOwnershipFinalReason: string | null
  honeypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  ownerRenounced: boolean | null
  mintable: boolean | null
  proxy: boolean | null
  freezeOrBlacklist: boolean | null
  mintAuthorityActive: boolean | null
  freezeAuthorityActive: boolean | null
  deployerResolved: boolean
  rugHistoryCount: number | null
  sellable: boolean | null
  simStatus: string | null
  simReason: string | null
  usable: boolean
}

export function clarkTokenAnalystContainsFinancialAdvice(text: string): boolean {
  const t = String(text ?? "")
  if (/\bthis (?:token )?is safe\b/i.test(t)) return true
  if (/\byou should (?:buy|ape|sell|invest)\b/i.test(t)) return true
  if (/\bguaranteed safe\b/i.test(t)) return true
  return false
}

function chainFamily(chain: string | null | undefined): ClarkTokenAnalystChainFamily {
  const c = String(chain ?? "").toLowerCase()
  if (c.includes("sol")) return "solana"
  if (c.includes("robin")) return "robinhood"
  return "evm"
}

function isConcentrated(ev: TokenScanEvidence): boolean {
  const lp = ev.lpControl
  if (!lp) return false
  const hay = [lp.status, lp.poolType, lp.proofApplicability, lp.displayLpModel, lp.proofStatus]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return hay.includes("concentrated") || hay.includes("clmm") || hay.includes("v3") || hay.includes("v4")
    || lp.proofApplicability === "not_applicable" || lp.displayLpModel === "concentrated_liquidity"
}

function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "unverified"
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function fmtPct(n: number | null): string {
  return n == null || !Number.isFinite(n) ? "unverified" : `${n.toFixed(1)}%`
}

// LP-OWNERSHIP-AUDIT-WIRED, DISCLOSED: replaces the old snap.lpPositionProof === "confirmed"
// ternary (which produced the same hardcoded "LP position ownership is not verified." with no
// reason on every non-confirmed read) with the real finalStatus/finalReason from
// concentratedLpPositionOwnershipAudit (see lib/server/lpProof.ts's
// buildConcentratedLpPositionOwnershipAudit — the single mapping the Token Scanner UI also reads).
// A non-verified state always carries a concrete reason now; falls back to the exact required
// "not indexed" wording only when no audit reached Clark at all (older cached snapshot).
function lpOwnershipCopy(snap: ClarkTokenAnalystSnapshot): { verified: boolean; text: string } {
  const status = snap.lpPositionOwnershipFinalStatus
  const reason = snap.lpPositionOwnershipFinalReason
  if (status === "verified_position_owner" || status === "protocol_managed") {
    return { verified: true, text: reason ? `Concentrated LP position ownership is verified — ${reason}` : "Concentrated LP position ownership is verified." }
  }
  return { verified: false, text: reason || "Position owner proof unavailable — active liquidity positions not indexed." }
}

function simSellLabel(snap: ClarkTokenAnalystSnapshot): "Sellable" | "Blocked" | "Unsupported" | "Unavailable" | "Not applicable" {
  if (snap.family === "solana") return "Not applicable"
  if (snap.simStatus === "unsupported" || snap.simStatus === "unsupported_on_robinhood" || snap.simStatus === "not_supported") return "Unsupported"
  if (snap.sellable === false || snap.honeypot === true || snap.simStatus === "blocked" || snap.simStatus === "risk_detected") return "Blocked"
  if (snap.sellable === true || snap.honeypot === false || snap.simStatus === "sellable" || snap.simStatus === "verified_clear" || snap.simStatus === "simulated") return "Sellable"
  return "Unavailable"
}

export function classifyClarkTokenAnalystTopic(prompt: string): ClarkTokenAnalystTopic | null {
  const t = String(prompt ?? "").trim().toLowerCase()
  if (!t) return null
  if (/\b(can\s+i\s+sell|is\s+(?:it|this)\s+sellable|sellable\??|can\s+(?:i|you)\s+sell\s+this)\b/.test(t)) return "sell"
  if (/\b(what\s+are\s+the\s+taxes|buy\s+tax|sell\s+tax|trading\s+tax(?:es)?)\b/.test(t)) return "taxes"
  if (/\b(why\s+is\s+(?:this|it)(?:\s+token)?\s+pumping|why\s+(?:the\s+)?pump)\b/.test(t)) return "pumping"
  if (/\b(good\s+signs?|what(?:'s|\s+are)\s+the\s+good\s+signs?|bull\s+case)\b/.test(t)) return "good_signs"
  if (/\b(what\s+should\s+i\s+check\s+next|what\s+next|check\s+next)\b/.test(t)) return "next"
  if (/\b(biggest\s+red\s+flags?|what\s+are\s+(?:the\s+)?(?:biggest\s+)?red\s+flags?)\b/.test(t)) return "red_flags"
  if (/\bexplain\s+(?:the\s+)?(?:lp|liquidity)\b/.test(t) || /\bwhat\s+does\s+(?:lp|liquidity)\s+mean\b/.test(t)) return "explain_lp"
  if (/\bexplain\s+(?:the\s+)?holders?\b/.test(t)) return "explain_holders"
  if (/\bexplain\s+(?:the\s+)?(?:dev|deployer|ownership)\b/.test(t)) return "explain_dev"
  if (/\bexplain\s+(?:the\s+)?(?:risk|risk\s+score|verdict)\b/.test(t)) return "explain_risk"
  if (/\bexplain\s+(?:the\s+)?market\b/.test(t)) return "explain_market"
  if (/\b(is\s+lp\s+safe|is\s+(?:the\s+)?(?:lp|liquidity)\s+safe|lp\s+safe\??)\b/.test(t)) return "lp"
  if (/\b(who\s+controls\s+(?:the\s+)?supply|supply\s+control)\b/.test(t)) return "supply"
  if (/\b(has\s+(?:this|the)\s+dev(?:eloper)?\s+(?:ever\s+)?rugged|rugged\s+before|dev\s+rug\s+history)\b/.test(t)) return "dev"
  if (/\b(is\s+holder\s+concentration\s+bad|holders?\s+concentrated|holder\s+concentration)\b/.test(t)) return "holders"
  if (/\b(why\s+(?:is\s+(?:the\s+)?)?(?:risk|it|this)\s+(?:score\s+)?(?:high|low)|why\s+risk|risk\s+score|why\s+(?:the\s+)?caution|why\s+risky)\b/.test(t)) return "risk"
  if (/\b(safe\s+to\s+ape|ape\s+(?:this|it)|full\s+risk\s+breakdown)\b/.test(t)) return "safe"
  if (/\b(is\s+(?:this|it)(?:\s+token)?\s+safe|token\s+safe|should\s+i\s+buy|is\s+this\s+ca\s+safe|^safe\??$)\b/.test(t)) return "safe"
  return null
}

export function buildClarkTokenAnalystSnapshot(ev: TokenScanEvidence, chainLabel = "Base"): ClarkTokenAnalystSnapshot {
  const family = chainFamily(ev.chain ?? chainLabel)
  const risk = normalizeRiskScore({
    rawScore: ev.riskScore,
    rawScoreType: ev.riskScoreType ?? "risk_score",
    source: "clark_token_analyst",
    displayLocation: "clark_token_analyst",
  })
  const sim = ev.tradingSimulation
  const rug = ev.deployerProfile && typeof ev.deployerProfile === "object"
    ? (ev.deployerProfile as Record<string, unknown>).rugHistory
    : null
  const mintAuth = family === "solana"
    ? (ev.security?.mintable === true ? true : ev.security?.mintable === false ? false : null)
    : null
  const freezeAuth = family === "solana"
    ? (ev.security?.blacklist === true ? true : ev.security?.blacklist === false ? false : null)
    : null
  const lpConcentrated = isConcentrated(ev)
  const lpStatus = ev.lpControl?.status ?? null
  const lpVerified = Boolean(lpStatus && !["open_check", "unverified", "unknown"].includes(lpStatus)) && !lpConcentrated
    ? (lpStatus === "locked" || lpStatus === "burned")
    : Boolean(ev.lpControl?.positionProofStatus === "confirmed" || ev.lpControl?.proofStatus === "confirmed")
  return {
    chain: chainLabel,
    family,
    symbol: String(ev.token?.symbol ?? "?").toUpperCase(),
    address: ev.token?.address ?? null,
    riskScore: risk.riskScore0To100,
    riskLabel: risk.riskLabel,
    liquidityUsd: ev.market?.liquidity ?? null,
    volume24h: ev.market?.volume24h ?? null,
    change24h: ev.market?.change24h ?? null,
    marketCap: ev.market?.marketCap ?? null,
    top1Pct: ev.holders?.top1 ?? null,
    top10Pct: ev.holders?.top10 ?? null,
    holderCount: ev.holders?.holderCount ?? null,
    holdersVerified: ev.holders?.top1 != null || ev.holders?.top10 != null,
    marketVerified: ev.market?.liquidity != null || ev.market?.price != null || ev.market?.volume24h != null,
    lpStatus,
    lpPoolType: ev.lpControl?.poolType ?? ev.lpControl?.displayLpModel ?? null,
    lpProofStatus: ev.lpControl?.proofStatus ?? ev.lpControl?.lockStatus ?? null,
    lpPositionProof: ev.lpControl?.positionProofStatus ?? null,
    lpConcentrated,
    lpVerified,
    lpPositionOwnershipFinalStatus: ev.lpControl?.positionOwnershipFinalStatus ?? null,
    lpPositionOwnershipFinalReason: ev.lpControl?.positionOwnershipFinalReason ?? null,
    honeypot: family === "solana" ? null : (ev.security?.honeypot ?? null),
    buyTax: family === "solana" ? null : (sim?.buyTax ?? ev.security?.buyTax ?? null),
    sellTax: family === "solana" ? null : (sim?.sellTax ?? ev.security?.sellTax ?? null),
    ownerRenounced: family === "solana" ? null : (ev.security?.ownerRenounced ?? null),
    mintable: family === "solana" ? mintAuth : (ev.security?.mintable ?? null),
    proxy: family === "solana" ? null : (ev.security?.proxy ?? null),
    freezeOrBlacklist: family === "solana" ? freezeAuth : (ev.security?.blacklist ?? null),
    mintAuthorityActive: mintAuth,
    freezeAuthorityActive: freezeAuth,
    deployerResolved: Boolean(ev.deployerAddress),
    rugHistoryCount: typeof rug === "number" ? rug : null,
    sellable: family === "solana" ? null : (sim?.sellable ?? null),
    simStatus: family === "solana" ? "not_applicable" : (sim?.status ?? null),
    simReason: sim?.reason ?? null,
    usable: hasUsableTokenEvidence(ev),
  }
}

function verdictWord(snap: ClarkTokenAnalystSnapshot, ev: TokenScanEvidence): string {
  if (snap.honeypot === true || snap.sellable === false) return "Avoid"
  if (snap.riskLabel) {
    if (snap.riskLabel === "Low Risk" || snap.riskLabel === "Moderate Risk") return "Caution"
    if (snap.riskLabel === "Caution") return "Caution"
    if (snap.riskLabel === "High Risk") return "High Risk"
    return "Extreme Risk"
  }
  const input = buildClarkTokenVerdictInputFromEvidence(ev)
  if (snap.family === "solana") input.lpUnsupportedOnChain = true
  const scored = computeClarkTokenVerdictCore(input, snap.usable)
  if (scored.verdict === "Avoid") return "Avoid"
  if (scored.verdict === "High Risk") return "High Risk"
  if (scored.verdict === "Partial Evidence") return "Open Check"
  return "Caution"
}

type Bucket = { verified: string[]; partial: string[]; missing: string[]; unsupported: string[]; risks: string[]; goods: string[] }

function collect(snap: ClarkTokenAnalystSnapshot): Bucket {
  const verified: string[] = []
  const partial: string[] = []
  const missing: string[] = []
  const unsupported: string[] = []
  const risks: string[] = []
  const goods: string[] = []

  if (snap.marketVerified) {
    verified.push(`Market data verified${snap.liquidityUsd != null ? ` — liquidity ${fmtUsd(snap.liquidityUsd)}` : ""}${snap.volume24h != null ? `, 24h volume ${fmtUsd(snap.volume24h)}` : ""}.`)
    if (snap.liquidityUsd != null && snap.liquidityUsd > 0) goods.push("Liquidity is present.")
  } else missing.push("Market data not returned.")

  if (snap.holdersVerified) {
    verified.push(`Holder map verified — top-1 ${fmtPct(snap.top1Pct)}, top-10 ${fmtPct(snap.top10Pct)}.`)
    if ((snap.top1Pct != null && snap.top1Pct >= 40) || (snap.top10Pct != null && snap.top10Pct >= 70)) {
      risks.push(`Holder concentration is high (top-1 ${fmtPct(snap.top1Pct)}, top-10 ${fmtPct(snap.top10Pct)}).`)
    } else if (snap.top10Pct != null && snap.top10Pct >= 40) {
      risks.push(`Top-holder concentration is moderate (top-10 ${fmtPct(snap.top10Pct)}).`)
    } else {
      goods.push("Holder concentration is not extreme on current rows.")
    }
  } else missing.push("Holder concentration not verified.")

  if (snap.family === "solana") {
    unsupported.push("Standard ERC-20 owner/admin wording does not apply on Solana.")
    unsupported.push("EVM honeypot/tax simulation is not applicable on Solana.")
    if (snap.mintAuthorityActive === true) {
      verified.push("Mint authority is active — supply can still be increased.")
      risks.push("Mint authority is still active.")
    } else if (snap.mintAuthorityActive === false) {
      verified.push("Mint authority is revoked.")
      goods.push("Mint authority revoked.")
    } else missing.push("Mint authority unresolved.")
    if (snap.freezeAuthorityActive === true) {
      verified.push("Freeze authority is active — accounts can be frozen.")
      risks.push("Freeze authority is still active.")
    } else if (snap.freezeAuthorityActive === false) {
      verified.push("Freeze authority is revoked.")
      goods.push("Freeze authority revoked.")
    } else missing.push("Freeze authority unresolved.")
    missing.push("Solana AMM LP lock/burn is not the same check as an EVM LP-token lock.")
  } else if (snap.lpConcentrated) {
    unsupported.push("Standard ERC-20 LP lock/burn is not applicable to this V3/V4 concentrated pool.")
    const ownership = lpOwnershipCopy(snap)
    if (ownership.verified) {
      verified.push(ownership.text)
      goods.push("LP position ownership verified.")
    } else {
      missing.push(ownership.text)
      risks.push(ownership.text)
    }
  } else if (snap.lpStatus === "locked" || snap.lpStatus === "burned") {
    verified.push(`LP is ${snap.lpStatus} on current proof.`)
    goods.push(`LP ${snap.lpStatus}.`)
  } else if (snap.lpStatus === "wallet_controlled" || snap.lpStatus === "team_controlled") {
    verified.push("LP tokens appear wallet/team controlled — liquidity can be pulled.")
    risks.push("LP is wallet/team controlled.")
  } else if (snap.lpStatus) {
    partial.push(`LP proof is ${snap.lpStatus} — not fully confirmed.`)
  } else {
    missing.push("LP lock/control not confirmed.")
  }

  if (snap.family === "robinhood") {
    const sell = simSellLabel(snap)
    if (sell === "Unsupported" || sell === "Unavailable") {
      unsupported.push("Some Robinhood trading-simulation checks are unsupported or unavailable on this scan.")
    }
  }

  if (snap.family !== "solana") {
    if (snap.honeypot === true) {
      verified.push("Trading simulation flagged a blocked/honeypot sell path.")
      risks.push("Simulated sell is blocked.")
    } else if (snap.honeypot === false) {
      verified.push(`Trading simulation did not flag a honeypot. Buy tax ${fmtPct(snap.buyTax)}, sell tax ${fmtPct(snap.sellTax)}.`)
      if ((snap.buyTax ?? 0) < 10 && (snap.sellTax ?? 0) < 10) goods.push("Taxes look low on the simulation.")
    } else if (snap.simStatus === "unsupported" || snap.simStatus === "unsupported_on_robinhood") {
      unsupported.push("Trading simulation is unsupported on this chain/pool.")
    } else {
      missing.push("Trading simulation (sellability/tax) not confirmed.")
    }
    if (snap.ownerRenounced === true) {
      verified.push("Contract owner is renounced.")
      goods.push("Owner renounced.")
    } else if (snap.ownerRenounced === false) {
      verified.push("Contract owner is still active.")
      risks.push("Owner/admin control is still active.")
    } else {
      missing.push("Ownership/dev origin unresolved.")
    }
    if (snap.mintable === true) {
      verified.push("Mint function is present.")
      risks.push("Supply is mintable.")
    } else if (snap.mintable === false) {
      verified.push("Mint not detected.")
    }
    if (snap.proxy === true) {
      verified.push("Contract is a proxy — logic can change.")
      risks.push("Proxy/upgradeable contract.")
    }
  }

  if (snap.rugHistoryCount != null && snap.rugHistoryCount > 0) {
    verified.push(`Deployer has ${snap.rugHistoryCount} confirmed prior rug${snap.rugHistoryCount === 1 ? "" : "s"} on record.`)
    risks.push("Confirmed prior rug history.")
  } else if (!snap.deployerResolved) {
    missing.push("Dev origin unresolved.")
  } else if (snap.rugHistoryCount === 0) {
    verified.push("No confirmed prior rugs in this read.")
  } else {
    missing.push("Dev rug history not confirmed.")
  }

  return { verified, partial, missing, unsupported, risks, goods }
}

function bullets(items: string[], empty: string): string[] {
  if (!items.length) return [`- ${empty}`]
  return items.slice(0, 5).map((x) => `- ${x}`)
}

function nextAction(snap: ClarkTokenAnalystSnapshot, topic: ClarkTokenAnalystTopic, bucket: Bucket): string {
  if (topic === "sell" || topic === "taxes") return "Treat simulated sell/tax as one check only — still review LP, holders, and dev in Token Scanner."
  if (topic === "lp" || topic === "explain_lp") {
    if (snap.lpConcentrated) return "Review V3/V4 position ownership, pool depth, and holder concentration next."
    if (snap.family === "solana") return "Review Solana pool depth and mint/freeze authority — do not look for an ERC-20 LP lock."
    return "Open /lp, then /holders and /deployer."
  }
  if (topic === "holders" || topic === "explain_holders") return "Open /holders, then check LP control and deployer."
  if (topic === "dev" || topic === "supply" || topic === "explain_dev") return "Open /deployer, then confirm LP control and holder concentration."
  if (bucket.missing.some((m) => /LP/.test(m))) return "Verify LP proof (or V3/V4 position ownership) in Token Scanner."
  if (bucket.missing.some((m) => /Dev origin|rug history|Mint authority/.test(m))) return "Resolve deployer/dev origin with /deployer."
  if (bucket.missing.some((m) => /Holder/.test(m))) return "Load the holder map in Token Scanner."
  return "Open Token Scanner and resolve the missing checks before treating this as verified."
}

function verdictLine(snap: ClarkTokenAnalystSnapshot, ev: TokenScanEvidence, topic: ClarkTokenAnalystTopic, bucket: Bucket): string {
  const word = verdictWord(snap, ev)
  const scoreBit = snap.riskScore != null ? `${snap.riskScore}/100 = ${snap.riskLabel ?? word}` : word

  if (topic === "sell") {
    const sell = simSellLabel(snap)
    const tax = `Buy tax: ${fmtPct(snap.buyTax)}. Sell tax: ${fmtPct(snap.sellTax)}.`
    return `Verdict: ${sell}. Trading simulation: ${sell}. ${tax} This only proves simulated sell behaviour, not full token safety.`
  }
  if (topic === "taxes") {
    if (snap.family === "solana") return "Verdict: Unsupported. EVM buy/sell tax simulation is not applicable on Solana."
    if (snap.buyTax == null && snap.sellTax == null) return `Verdict: ${simSellLabel(snap)}. Buy tax: unverified. Sell tax: unverified. Tax figures were not returned.`
    return `Verdict: ${word}. Buy tax: ${fmtPct(snap.buyTax)}. Sell tax: ${fmtPct(snap.sellTax)}. Taxes are simulated, not a safety clearance.`
  }
  if (topic === "risk" || topic === "explain_risk") {
    const drivers = bucket.risks.slice(0, 3).map((r) => r.replace(/\.$/, "")).join("; ")
    const goods = bucket.goods.slice(0, 3).map((g) => g.replace(/\.$/, "")).join("; ")
    return `Verdict: ${scoreBit}. Main drivers: ${drivers || "no confirmed risk driver in this read"}. Good signs: ${goods || "none confirmed"}.`
  }
  if (topic === "lp" || topic === "explain_lp") {
    if (snap.family === "solana") return "Verdict: Open Check. Solana pool liquidity is not an ERC-20 LP lock/burn. I would not call LP safe from that wording."
    if (snap.lpConcentrated) {
      const owned = lpOwnershipCopy(snap).text
      return `Verdict: Caution. ${owned}. Standard ERC-20 LP lock/burn is not applicable to this V3/V4 pool.`
    }
    if (snap.lpStatus === "locked" || snap.lpStatus === "burned") return `Verdict: Caution. LP is ${snap.lpStatus} on current proof — that is not the same as the token being safe.`
    if (snap.lpStatus === "wallet_controlled" || snap.lpStatus === "team_controlled") return "Verdict: High Risk. LP appears wallet/team controlled, so liquidity can be pulled."
    return "Verdict: Open Check. LP lock/control is not verified. I would not treat LP as safe."
  }
  if (topic === "holders" || topic === "explain_holders") {
    if (!snap.holdersVerified) return "Verdict: Open Check. Holder concentration was not returned — missing rows are not distributed supply."
    const bad = (snap.top1Pct != null && snap.top1Pct >= 40) || (snap.top10Pct != null && snap.top10Pct >= 70)
    const mid = snap.top10Pct != null && snap.top10Pct >= 40
    if (bad) return `Verdict: High Risk. Holder concentration is verified and elevated — top-1 ${fmtPct(snap.top1Pct)}, top-10 ${fmtPct(snap.top10Pct)}.`
    if (mid) return `Verdict: Caution. Holder concentration is verified and moderate — top-10 ${fmtPct(snap.top10Pct)}.`
    return `Verdict: Caution. Holder map is verified and not extreme (top-1 ${fmtPct(snap.top1Pct)}, top-10 ${fmtPct(snap.top10Pct)}). That is not a safety clearance.`
  }
  if (topic === "supply") {
    if (snap.family === "solana") {
      if (snap.mintAuthorityActive === true) return "Verdict: Caution. Mint authority is active, so supply can still be increased."
      if (snap.mintAuthorityActive === false) return "Verdict: Caution. Mint authority is revoked on current evidence — freeze authority and holders still matter."
      return "Verdict: Open Check. Who controls supply is unresolved — mint authority was not confirmed."
    }
    if (snap.mintable === true && snap.ownerRenounced === false) return "Verdict: High Risk. Supply is mintable and owner control is still active."
    if (snap.ownerRenounced === true && snap.mintable === false) return "Verdict: Caution. Owner is renounced and mint was not detected — LP and holders are still separate checks."
    return "Verdict: Open Check. Supply control is not fully verified."
  }
  if (topic === "dev") {
    if (snap.rugHistoryCount != null && snap.rugHistoryCount > 0) return `Verdict: Avoid. Confirmed prior rug history (${snap.rugHistoryCount}).`
    if (!snap.deployerResolved) return "Verdict: Open Check. Dev origin is unresolved — prior rug history is not confirmed."
    if (snap.rugHistoryCount === 0) return "Verdict: Caution. No confirmed prior rugs in this read. That is not a clean bill of health."
    return "Verdict: Open Check. Dev rug history was not confirmed."
  }
  if (topic === "pumping" || topic === "explain_market") {
    const chg = snap.change24h == null ? "24h change unverified" : `24h change ${snap.change24h >= 0 ? "+" : ""}${snap.change24h.toFixed(1)}%`
    return `Verdict: ${word}. ${chg}; volume ${fmtUsd(snap.volume24h)}; liquidity ${fmtUsd(snap.liquidityUsd)}. A pump is not a safety signal.`
  }
  if (topic === "red_flags") {
    return `Verdict: ${scoreBit}. Biggest red flags are listed below — missing checks are listed separately, not as confirmed faults.`
  }
  if (topic === "good_signs") {
    return `Verdict: ${word}. Confirmed good signs only — missing data is not a green flag.`
  }
  if (topic === "next") {
    return `Verdict: ${word}. Next check is the highest-value open item, not a trade instruction.`
  }

  const hold = snap.holdersVerified ? "Holder concentration is verified" : "holder concentration is not verified"
  const liq = snap.marketVerified && snap.liquidityUsd != null ? "liquidity exists" : "liquidity is unverified"
  const lpBit = snap.lpConcentrated
    ? lpOwnershipCopy(snap).text
    : (snap.lpVerified ? `LP is ${snap.lpStatus}` : "LP proof is not verified")
  const devBit = snap.deployerResolved ? "dev origin is resolved" : "dev origin is unresolved"
  return `Verdict: ${word}. ${hold} and ${liq}, but ${lpBit} and ${devBit}. I would not treat this as fully verified yet.`
}

function explainBody(topic: ClarkTokenAnalystTopic, snap: ClarkTokenAnalystSnapshot): string[] {
  if (topic === "explain_lp") {
    if (snap.family === "solana") return ["LP here means Solana pool liquidity, not an ERC-20 LP token that can be locked or burned."]
    if (snap.lpConcentrated) return ["This pool uses concentrated liquidity (V3/V4). There is no standard LP token to lock or burn — position ownership is the check."]
    return ["LP tokens represent pool inventory. If they are locked or burned, pulling liquidity is harder. If a wallet still holds them, liquidity can be pulled."]
  }
  if (topic === "explain_holders") {
    return ["Holder concentration is how much supply sits in the top wallets. High top-1 or top-10 share means a few wallets can move the price."]
  }
  if (topic === "explain_dev") {
    if (snap.family === "solana") return ["On Solana, control is mint authority and freeze authority — not an EVM owner-renounced flag."]
    return ["Dev/control means who can mint, upgrade, or still owns the contract. Renounced owner reduces those powers; it does not clear LP or holder risk."]
  }
  if (topic === "explain_risk") {
    return ["Risk score is 0–100, higher = riskier, from the same Token Scanner state as the page. Missing checks add caution; they do not auto-max the score."]
  }
  if (topic === "explain_market") {
    return ["Market is price, liquidity, volume, and cap. Visible liquidity is pool depth, not lock safety."]
  }
  return []
}

export function renderClarkTokenAnalystAnswer(ev: TokenScanEvidence, topic: ClarkTokenAnalystTopic, chainLabel = "Base"): string {
  const snap = buildClarkTokenAnalystSnapshot(ev, chainLabel)
  const bucket = collect(snap)
  const missingBlock = [...bucket.partial.map((p) => `Partial: ${p}`), ...bucket.missing, ...bucket.unsupported]
  const reasons = topic === "good_signs" ? bucket.goods
    : topic === "red_flags" ? bucket.risks
    : topic === "next" ? [nextAction(snap, topic, bucket)]
    : (bucket.risks.length ? bucket.risks : bucket.goods)
  const lines = [
    verdictLine(snap, ev, topic, bucket),
    "",
    "Key reasons:",
    ...bullets(topic === "next" ? [nextAction(snap, topic, bucket)] : (explainBody(topic, snap).length && topic.startsWith("explain_") ? explainBody(topic, snap).concat(reasons.slice(0, 2)) : reasons), "No confirmed driver in this read."),
    "",
    "Verified evidence:",
    ...bullets(bucket.verified, "None — core checks did not return verified data."),
    "",
    "Missing / unsupported checks:",
    ...bullets(missingBlock, "None — core checks returned."),
    "",
    "Next action:",
    `- ${nextAction(snap, topic, bucket)}`,
  ]
  if (topic === "safe" || topic === "sell") {
    lines.push("", "This is a ChainLens risk read, not financial advice.")
  }
  return lines.join("\n")
}

export function renderClarkTokenAnalystFromEvidence(ev: TokenScanEvidence, prompt: string, chainLabel = "Base", fallback: ClarkTokenAnalystTopic = "safe"): string {
  return renderClarkTokenAnalystAnswer(ev, classifyClarkTokenAnalystTopic(prompt) ?? fallback, chainLabel)
}

export function clarkTokenAnalystIntentBadge(topic: ClarkTokenAnalystTopic): string {
  if (topic === "lp" || topic === "explain_lp") return "token_lp_read"
  if (topic === "holders" || topic === "explain_holders") return "token_holders_read"
  if (topic === "dev" || topic === "supply" || topic === "explain_dev") return "token_dev_read"
  if (topic === "sell" || topic === "taxes") return "token_trade_sim"
  if (topic === "risk" || topic === "explain_risk" || topic === "red_flags") return "risk_explanation"
  return "token_analyst_followup"
}

export function tokenScanEvidenceFromSolanaScan(input: {
  tokenAddress: string
  tokenName?: string | null
  tokenSymbol?: string | null
  mintAuthority?: string | null
  mintAuthorityResolved?: boolean
  freezeAuthority?: string | null
  freezeAuthorityResolved?: boolean
  marketCap?: number | null
  fdv?: number | null
  liquidityUsd?: number | null
  volume24h?: number | null
  top1Pct?: number | null
  top10Pct?: number | null
  accountsSampled?: number | null
  likelyCreator?: string | null
  rugHistoryCount?: number | null
  usable?: boolean
}): TokenScanEvidence {
  const mintResolved = input.mintAuthorityResolved === true
  const freezeResolved = input.freezeAuthorityResolved === true
  return {
    ok: input.usable !== false,
    token: { name: input.tokenName ?? null, symbol: input.tokenSymbol ?? null, address: input.tokenAddress },
    chain: "solana",
    market: {
      price: null,
      change24h: null,
      volume24h: input.volume24h ?? null,
      liquidity: input.liquidityUsd ?? null,
      marketCap: input.marketCap ?? null,
      fdv: input.fdv ?? null,
    },
    holders: {
      top1: input.top1Pct ?? null,
      top10: input.top10Pct ?? null,
      holderCount: input.accountsSampled ?? null,
      status: input.top1Pct != null || input.top10Pct != null ? "ok" : "unavailable",
    },
    security: {
      honeypot: null,
      buyTax: null,
      sellTax: null,
      ownerRenounced: null,
      mintable: mintResolved ? Boolean(input.mintAuthority) : null,
      proxy: null,
      blacklist: freezeResolved ? Boolean(input.freezeAuthority) : null,
    },
    lpControl: null,
    deployerAddress: input.likelyCreator ?? null,
    deployerProfile: { rugHistory: input.rugHistoryCount ?? null },
    tradingSimulation: {
      sellable: null,
      status: "not_applicable",
      buyTax: null,
      sellTax: null,
      reason: "EVM honeypot simulation is not applicable on Solana.",
    },
  }
}
