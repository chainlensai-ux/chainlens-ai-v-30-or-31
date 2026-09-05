// CHAIN SELECTION SWAP SIGNAL, DISCLOSED (Wallet Scanner audit, Item 5 — "chain selection hardcodes
// swapCandidateEvents=0, visible_value_usd=0... wire real available signals where safe so a
// swap-active chain is not incorrectly downgraded to dust_low_signal").
//
// runWalletScan() is 3500+ lines with a deep provider/KV/scheduler dependency graph — not
// fixture-testable in isolation (same reasoning as scanPerformance.staticCheck.test.ts and
// ingestionSerialization.staticCheck.test.ts). This reads the real source and asserts the exact
// wiring the fix depends on. See src/modules/chainSelection/chainSelection.test.ts for the
// fixture-level proof that a real swapCandidateEvents count rescues a chain from dust_low_signal.
//
// Run directly with:
//   npx tsx --test src/pipeline/chainSelectionSwapSignal.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

describe('buildChainSelectionObject is fed a real, non-fabricated swapCandidateEvents signal', () => {
  it('computes swapCandidateEventsByChain from real router-touching events (KNOWN_DEX_ROUTER_ADDRESSES ∪ inferredRouterAddresses), counting any direction', () => {
    assert.match(
      src,
      /const touchesRouter = KNOWN_DEX_ROUTER_ADDRESSES\.has\(from\) \|\| KNOWN_DEX_ROUTER_ADDRESSES\.has\(to\)\s*\n\s*\|\| inferredRouterAddresses\.has\(from\) \|\| inferredRouterAddresses\.has\(to\)/,
      'the swap-candidate signal must be derived from the same shared, verified router registry plus router inference — never a new/invented address source',
    )
    assert.match(
      src,
      /swapCandidateEventsByChain\.set\(event\.chain, \(swapCandidateEventsByChain\.get\(event\.chain\) \?\? 0\) \+ 1\)/,
      'counts must be accumulated per real event, never estimated',
    )
  })

  it('wires the real per-chain count into buildChainSelectionObject, replacing the old hardcoded-0 default', () => {
    assert.match(
      src,
      /swapCandidateEvents: swapCandidateEventsByChain\.get\(r\.chain\) \?\? 0,/,
      'buildChainSelectionObject must receive the real computed count (falling back to honest 0 only for a chain with zero router-touching events)',
    )
  })

  it('visible_value_usd is never fabricated — no holdings-pricing signal exists at this pipeline stage, so it is deliberately left at its honest default', () => {
    assert.doesNotMatch(
      src,
      /visibleValueUsd:\s*(?!undefined)[\w.]/,
      'visibleValueUsd must never be synthesized from an estimate at the chainSelection call site',
    )
  })

  it('the computation runs AFTER routerInference and BEFORE buildChainSelectionObject, using already-computed evidence only', () => {
    const routerInferenceIndex = src.indexOf('const inferredRouterAddresses = routerInferenceResult.highConfidenceRouters')
    const signalComputeIndex = src.indexOf('const swapCandidateEventsByChain = new Map<string, number>()')
    const chainSelectionCallIndex = src.indexOf('const chainSelection: ChainSelectionResult = buildChainSelectionObject(')
    assert.ok(routerInferenceIndex > 0 && signalComputeIndex > routerInferenceIndex, 'the signal must be computed after inferredRouterAddresses already exists')
    assert.ok(chainSelectionCallIndex > signalComputeIndex, 'buildChainSelectionObject must be called after the real signal is computed')
  })
})
