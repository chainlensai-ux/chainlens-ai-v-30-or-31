# Notes — Known Gaps & Stubs

Authoritative list of what is **not** real/production-wired today, so it doesn't get assumed or documented as a working feature elsewhere in this vault.

1. **Wallet Compare.** `wallet_compare` intent and `formatWalletCompareUnsupported()` exist in `clarkRouting.ts`, but there is no real side-by-side comparison engine. Current behavior: recommends scanning each wallet separately. See [[Wallet-Scanner]].
2. **Uniswap V4.** Not unsupported, but handled differently — recognized as `concentrated_liquidity` rather than forced through the V2-style ERC-20 LP burn/lock proof (which doesn't apply, since V4 positions aren't ERC-20 LP tokens). Uses position-owner sampling instead. See [[Liquidity-LP-Proof]].
3. **Non-Base/Ethereum chains for Token Scanner.** `toTokenApiChain()` returns `null` for Polygon, BNB, Arbitrum — token scans on these chains return "chain not yet supported," not a degraded/best-effort scan. See [[Supported-Chains-Limitations]].
4. **Copy-trade advice.** Explicitly blocked by the system prompt — not a missing feature, a deliberate refusal. See [[Guardrails-and-Refusal-Rules]].
5. **Concentrated-liquidity full-pool sampling source.** As of the Stage 14 work (see `lib/server/lpProof.ts`, `SAMPLE_CANDIDATE_CAP`), there is a bounded, test-injectable `sampleCandidates` hook, but **no real production candidate-discovery source is wired in** (no subgraph, no cached logs, no indexed transfer table). Production currently reports `samplingStatus: "attempted_no_candidates"` for essentially all real V3 pools until a real bounded source is added — this is intentional (per explicit instruction: do not invent a candidate source), not a bug.

## Rule for this vault

When documenting a capability, check this file first. If something here applies, the capability note must say so explicitly rather than describing the stub as if it were fully live.
