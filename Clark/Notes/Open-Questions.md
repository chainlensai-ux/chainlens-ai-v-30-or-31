# Notes — Open Questions

Things this vault could not answer from code alone and should be verified with whoever owns the relevant part of the codebase before being treated as fact:

1. **Wallet Compare roadmap** — is a real comparison engine planned, or is the unsupported response intentionally permanent? See [[Known-Gaps-and-Stubs]] item 1.
2. **Concentrated LP candidate source** — is a real bounded source (indexed transfer log, cached event table) planned for V3/V4 position-owner sampling, or does this stay sample-only indefinitely? See [[Known-Gaps-and-Stubs]] item 5.
3. **Multi-chain expansion for Token Scanner** — any plan to extend `toTokenApiChain()` beyond Base/Ethereum? See [[Supported-Chains-Limitations]].
4. **Rate limit store** — confirmed in-memory/per-process today ([[Rate-Limiting]]); if ChainLens runs multiple instances, is a shared store (Redis, etc.) planned?
5. **GoPlus Security usage** — confirmed wired in and chain-mapped, but exact role versus honeypot.is in the final risk score wasn't fully traceable from a single pass — worth a closer read of `riskScore.ts` if precise weighting matters for a future change.

## Maintenance note

This vault was generated from a code-grounded research pass (file paths/line numbers cited throughout). It reflects the codebase at the time of writing — re-verify against source before relying on exact line numbers, since those will drift as the code changes.
