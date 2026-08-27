import assert from 'node:assert/strict'
import fs from 'node:fs'

// LEGACY-CASCADE-CHAIN FIX, DISCLOSED.
//
// Reported live, immediately after the auto-chain-detection fix shipped: a real ETH token, asked
// "is it safe" with no chain named, no longer got the wrong "wallet, not a token contract" verdict
// (auto-detection correctly found the contract) — but the actual safety read still came back as
// "TOKEN SAFETY — ? (Base)" with unresolved symbol and generic evidence. The auto-chain-detection
// fix only updated chainForClarkTools and the entity gate + the token_scan TOOL inside
// executeClarkToolPlan — but "is it safe" (and most other natural-language token questions:
// dev_rug_check, lp_lock_check, risk_explanation, token_full_report, dev_rug_history, token_ape_
// risk) route through a COMPLETELY SEPARATE, much larger legacy cascade inside handleClarkAI
// itself (fetchTokenEvidence, resolveTokenForFollowup, and ~15 formatter call sites) that still
// read the plain `chain` variable directly — the pre-auto-detection default — never the corrected
// chainForClarkTools. This is in fact the DOMINANT code path for real user phrasing; the tool-plan
// path fixed earlier is comparatively narrow.
//
// Fix: every toTokenApiChain(chain) / tokenEvidenceChain(ev, chain) / chainDisplayLabel(chain)
// call site inside handleClarkAI's body now reads chainForClarkTools instead — the SAME single
// source of truth the entity gate and auto-detection already established, so this legacy cascade
// can never drift out of sync with it again.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// No call site anywhere in the route file may still read the plain, pre-detection `chain` variable
// for chain-sensitive lookups — every one of these must have been migrated to chainForClarkTools.
assert.doesNotMatch(routeCode, /toTokenApiChain\(chain\)/, 'no toTokenApiChain(chain) call may remain — all must use the auto-detected chainForClarkTools')
assert.doesNotMatch(routeCode, /tokenEvidenceChain\([a-zA-Z.]*, chain\)/, 'no tokenEvidenceChain(..., chain) fallback may remain — all must use chainForClarkTools')
assert.doesNotMatch(routeCode, /chainDisplayLabel\(chain\)/, 'no bare chainDisplayLabel(chain) call may remain — all must use chainForClarkTools')

// The actual scan call that feeds "is it safe" / dev_rug_check / lp_lock_check / risk_explanation
// / token_full_report / dev_rug_history must use the resolved chain — this is the exact site that
// reproduced the reported bug.
assert.match(routeCode, /const tokenInternalApiPayload = \{ contract: tokenAddress, chain: toTokenApiChain\(chainForClarkTools\)/, 'fetchTokenEvidence (the dominant scan path for natural-language token questions) must use the auto-detected chain')
assert.match(routeCode, /const honeypotChain = toTokenApiChain\(chainForClarkTools\);/, 'the independent honeypot/tax check inside the same scan must also use the auto-detected chain')

// tokenEvidenceChain itself must recognize every real chain, not just eth/ethereum/base — a BNB or
// Robinhood scan's own reported chain must never fall through to a stale fallback just because the
// function didn't know that chain existed.
assert.match(routeCode, /function tokenEvidenceChain\(ev: TokenScanEvidence \| null \| undefined, fallback: SupportedChain \| "robinhood"\): SupportedChain \| "robinhood" \{/, 'tokenEvidenceChain must accept and return the widened chain type')
assert.match(routeCode, /if \(raw === "bnb" \|\| raw === "bsc"\) return "bnb";/, 'tokenEvidenceChain must recognize a real BNB scan result')
assert.match(routeCode, /if \(raw === "robinhood"\) return "robinhood";/, 'tokenEvidenceChain must recognize a real Robinhood scan result')

console.log('test-clark-legacy-cascade-chain.mjs: all assertions passed')
