// MODULE — swapNormalizer: quoteLegRecovery()
//
// WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED (prod issue: "closedLots=0, fullyPricedLots=0,
// verifiedCoverage=0... quote-leg lookup has mostly one-leg txs and no verified quote address").
//
// ROOT CAUSE, CONFIRMED BY READING THE REAL PIPELINE: app/api/_shared/walletChainPipeline.ts's
// groupRawEventsIntoTxBundles() builds a RawTxBundle purely from whatever flat transfer legs the
// provider (GoldRush/Alchemy asset-transfers) happened to return for that tx — never `dexSwaps`,
// never `router`, never `logs` (those fields are always absent on this real path; see that file's
// own header). A very common real swap shape is exactly ONE relevant leg: the wallet's OUTGOING
// ERC20 transfer of the token being sold is well-indexed, but the INCOMING native-ETH send from the
// router (a raw value transfer, not an ERC20 Transfer event) is NOT — or the reverse for a buy.
// swapNormalizer's own missingSide handling (buySellDetector.ts) already does its best with the ONE
// known leg, but a real dollar VALUE for that trade still requires knowing what the missing side
// actually WAS — which this module recovers from the transaction's own receipt logs, never guessed.
//
// WHAT THIS MODULE DOES: decodes plain, universal, well-known ERC20 `Transfer(address,address,
// uint256)` event logs from an already-fetched receipt — no per-router ABI, no protocol-specific
// decoding (that stays explicitly out of scope, same boundary swapNormalizer's own header already
// draws) — looking for a transfer of a KNOWN quote asset (WETH/USDC/USDT/DAI on the chains this
// module covers) to or from the wallet within the SAME transaction as a one-leg candidate. When
// found, it is a real, on-chain, already-mined fact — never a fabricated amount or a guess at the
// counterparty's identity.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: recover a raw NATIVE ETH leg with no Transfer event at
// all (e.g. a router unwrapping WETH and sending native ETH via a low-level call produces no log a
// receipt can show — that requires a trace API most RPC providers restrict, out of scope here,
// same "keep focused" boundary the task itself draws). A swap that settled in raw native ETH with no
// WETH/stable Transfer log anywhere in the receipt remains a genuine one-leg trade after this module
// runs — its rejection reason is reported honestly (see QuoteLegRecoveryResult), never silently
// dropped.

const TRANSFER_EVENT_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// Independent literal copy of the same well-known addresses already verified elsewhere in this
// codebase (lib/engines/tradeTimelineEngineV2.ts's KNOWN_SYMBOLS, src/modules/tradeIntent/
// intentEngine.ts's BASE_STABLE_ADDRESSES) — kept separate per this module set's established
// "no runtime coupling between modules" convention (see swapNormalizer's own header for the
// precedent this follows).
export type QuoteLegChain = 'eth' | 'base'

const QUOTE_ASSETS_BY_CHAIN: Record<QuoteLegChain, Record<string, { symbol: string; kind: 'native_wrapped' | 'stable' }>> = {
  eth: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', kind: 'native_wrapped' },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', kind: 'stable' },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', kind: 'stable' },
    '0x6b175474e89094c44da98b954eedeac495271d0': { symbol: 'DAI', kind: 'stable' },
  },
  base: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', kind: 'native_wrapped' },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', kind: 'stable' },
  },
}

export function isKnownQuoteAssetAddress(chain: QuoteLegChain, address: string): { symbol: string; kind: 'native_wrapped' | 'stable' } | null {
  return QUOTE_ASSETS_BY_CHAIN[chain][address.toLowerCase()] ?? null
}

// A minimal, provider-agnostic receipt-log shape — deliberately narrower than a full JSON-RPC log
// object (only the fields this module's decoding actually needs), so a caller adapting any RPC
// client's real response only has to map these four fields.
export type RawReceiptLog = {
  logIndex: number
  address: string
  topics: string[]
  data: string
}

export type RecoveredQuoteLeg = {
  contract: string
  symbol: string
  kind: 'native_wrapped' | 'stable'
  amountRaw: string
  // 'in' = wallet received this quote asset (recovers a missing tokenOut); 'out' = wallet sent it
  // (recovers a missing tokenIn).
  direction: 'in' | 'out'
  logIndex: number
  // Real on-chain counterparty addresses from the Transfer log itself — never fabricated. Always
  // present: exactly one of them equals the wallet address (the other is the real from/to the
  // Transfer log carried).
  from: string
  to: string
}

function topicToAddress(topic: string): string {
  // A Transfer log's indexed address topics are always 32-byte, left-zero-padded — the real address
  // is the last 20 bytes (40 hex chars).
  return `0x${topic.slice(-40)}`.toLowerCase()
}

// Decodes every standard ERC20 Transfer log in `logs` that involves `walletAddress` as sender or
// recipient, for a token this module recognizes as a quote asset on `chain`. Pure: no I/O, no
// mutation of `logs`. A log that doesn't match the Transfer topic0, has malformed topics, or is for
// an unrecognized token contract is silently skipped — never guessed into a fabricated leg.
export function decodeQuoteAssetTransfers(logs: readonly RawReceiptLog[], walletAddress: string, chain: QuoteLegChain): RecoveredQuoteLeg[] {
  const wallet = walletAddress.toLowerCase()
  const out: RecoveredQuoteLeg[] = []
  for (const log of logs) {
    if (!log.topics || log.topics.length < 3) continue
    if (log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC0) continue
    const quote = isKnownQuoteAssetAddress(chain, log.address)
    if (!quote) continue
    const from = topicToAddress(log.topics[1])
    const to = topicToAddress(log.topics[2])
    if (from !== wallet && to !== wallet) continue
    if (!log.data || !/^0x[0-9a-fA-F]*$/.test(log.data)) continue
    out.push({
      contract: log.address.toLowerCase(),
      symbol: quote.symbol,
      kind: quote.kind,
      amountRaw: BigInt(log.data).toString(),
      direction: to === wallet ? 'in' : 'out',
      logIndex: log.logIndex,
      from,
      to,
    })
  }
  return out
}

export type QuoteLegRecoveryOutcome =
  | { status: 'recovered'; leg: RecoveredQuoteLeg }
  | { status: 'no_quote_transfer_in_receipt' }
  | { status: 'wrong_direction_only' }

// Given the already-decoded quote-asset transfers for one transaction and which side of the trade
// is missing, picks the best real match — the transfer whose direction actually fills the gap
// (missingSide='tokenOut' needs an INCOMING quote leg; missingSide='tokenIn' needs an OUTGOING one).
// When several match (rare — most swaps have exactly one quote leg), the highest logIndex is kept
// (the final settlement leg, closest to the trade's actual completion), same tie-break convention
// swapNormalizer's own reconstructFromTransfers uses for its "latest incoming" pick.
export function recoverMissingQuoteLeg(
  logs: readonly RawReceiptLog[],
  walletAddress: string,
  chain: QuoteLegChain,
  missingSide: 'tokenIn' | 'tokenOut',
): QuoteLegRecoveryOutcome {
  const candidates = decodeQuoteAssetTransfers(logs, walletAddress, chain)
  if (candidates.length === 0) return { status: 'no_quote_transfer_in_receipt' }

  const neededDirection = missingSide === 'tokenOut' ? 'in' : 'out'
  const matching = candidates.filter((c) => c.direction === neededDirection)
  if (matching.length === 0) return { status: 'wrong_direction_only' }

  const best = matching.reduce((a, b) => (b.logIndex > a.logIndex ? b : a))
  return { status: 'recovered', leg: best }
}

// A minimal, provider-agnostic transfer shape — the fields this function needs from a bundle's
// already-fetched transfers, independent of RawTransfer's fuller shape so this stays a small, pure,
// dependency-free unit (matching swapNormalizer's own "no runtime coupling" convention).
export type CandidateTransfer = { contract: string; from: string; to: string }

export type RecoveryCandidate =
  | { candidate: true; missingSide: 'tokenIn' | 'tokenOut'; knownContract: string }
  | { candidate: false; reason: 'both_legs_present' | 'no_wallet_facing_transfer' | 'known_leg_already_quote_asset' }

// Identifies whether a transaction's already-fetched transfers form a genuine one-leg
// quote-recovery candidate: exactly one direction (incoming or outgoing) touches the wallet, and
// the known leg is NOT itself a quote asset (recovering the identity of a non-quote counterparty
// leg — i.e. which memecoin was on the other side — is a materially different, much less
// constrained problem this module does not attempt; see file header). Pure, deterministic.
export function identifyRecoveryCandidate(transfers: readonly CandidateTransfer[], walletAddress: string, chain: QuoteLegChain): RecoveryCandidate {
  const wallet = walletAddress.toLowerCase()
  const outgoing = transfers.filter((t) => t.from.toLowerCase() === wallet)
  const incoming = transfers.filter((t) => t.to.toLowerCase() === wallet)

  if (outgoing.length > 0 && incoming.length > 0) return { candidate: false, reason: 'both_legs_present' }
  if (outgoing.length === 0 && incoming.length === 0) return { candidate: false, reason: 'no_wallet_facing_transfer' }

  const known = outgoing.length > 0 ? outgoing[outgoing.length - 1] : incoming[incoming.length - 1]
  if (isKnownQuoteAssetAddress(chain, known.contract)) return { candidate: false, reason: 'known_leg_already_quote_asset' }

  // Wallet only sent (outgoing known, no incoming) -> the missing side is what they RECEIVED
  // (tokenOut, in swapNormalizer's own naming). Wallet only received -> missing side is tokenIn.
  return { candidate: true, missingSide: outgoing.length > 0 ? 'tokenOut' : 'tokenIn', knownContract: known.contract }
}
