import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const moralis = fs.readFileSync('lib/server/moralis.ts', 'utf8')

assert.match(snap, /eventKind: 'swap_candidate' \| 'transfer' \| 'airdrop_candidate' \| 'bridge_candidate' \| 'contract_interaction' \| 'lp_event'/, 'swap detection has an LP event quarantine kind')
assert.match(snap, /Liquidity add\/remove shape detected[\s\S]*excluded from cost basis and realized PnL/, 'LP add/remove transactions are excluded from FIFO/PnL')
assert.match(snap, /MULTIHOP-MERGE-FIX[\s\S]*same-tx fragments[\s\S]*weightedPrice/, 'same-tx multi-hop fragments are merged before FIFO matching')
assert.match(snap, /fetchMoralisHistoricalTokenPrice\(e\.contract, e\.chain, e\.timestamp\)/, 'priceAtTime uses Moralis historical token price fallback after GoldRush misses')
assert.match(moralis, /export async function fetchMoralisHistoricalTokenPrice/, 'Moralis historical price helper is implemented')
assert.match(moralis, /to_date=\$\{encodeURIComponent\(toDate\)\}/, 'Moralis historical price request is timestamp scoped')
assert.match(snap, /e\.swapDetection\.eventKind === 'airdrop_candidate' \|\| e\.swapDetection\.eventKind === 'lp_event'/, 'FIFO explicitly rejects LP events')

console.log('wallet pnl pipeline audit fix checks passed')
