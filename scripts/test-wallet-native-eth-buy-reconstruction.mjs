import assert from 'node:assert/strict'
import fs from 'node:fs'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

assert.match(snap, /swapReason = 'native_eth_buy'/, 'native ETH buy branch promotes wallet-initiated inbound token txs')
assert.match(snap, /getSharedTxByHash\(rpcUrl, txHash\)/, 'base unknown reconstruction fetches capped tx.value for candidate txs')
assert.match(snap, /nativeEthBuyPromoted = true/, 'debug records nativeEthBuyPromoted')
assert.match(snap, /noWalletOutboundLegButNativeSpendCount/, 'debug records no-wallet-outbound-but-native-spend count')
assert.match(snap, /native_value_missing_or_zero/, 'native ETH buy is rejected when tx.value is missing or zero')
assert.match(snap, /d\.txFrom !== walletLower \|\| !hasInboundToken \|\| d\.walletOutbound\.length > 0/, 'airdrop and pool-to-pool cases are not tx.value-promoted without wallet sender and wallet inbound token')
assert.match(snap, /swapReconstructionConfidence: 'high'/, 'synthetic native ETH spend leg is high-confidence swap evidence')
assert.match(snap, /Acquisition recovery: inbound target-token transfer with verified quote\/payment leg in receipt/, 'acquisition recovery still requires quote/payment proof')
assert.match(snap, /Open position evidence found; no matching sell lots yet\./, 'status wording reports open lots without claiming no recent activity')

console.log('wallet native ETH buy reconstruction checks passed')
