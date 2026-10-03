// Dumps the full receipt-quote path-attribution forensics for real transactions, using the exact
// production classifier (src/lib/receiptQuoteRecovery.ts). Read-only; needs a reachable RPC
// (BASE_RPC_URL / ALCHEMY_BASE_RPC_URL / ALCHEMY_BASE_KEY, else https://mainnet.base.org).
//
//   npx tsx scripts/receipt-quote-forensics.ts --wallet 0x... --token 0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3 \
//     --side entry --tx 0xdd4229cc... [--tx 0x03e40c89... ...] [--amount 1234.5] [--decimals 18] [--chain base]
//
// When --amount is omitted the receipt's own wallet target total is used, so the target-amount check
// passes by construction — pass the lot's normalized amount to reproduce the production check.

import { classifyReceiptQuoteEvidence, createInternalTransferTracer, createReceiptQuoteTxFetcher, TRANSFER_TOPIC0 } from '../src/lib/receiptQuoteRecovery'
import type { SupportedChain } from '../src/modules/providerFetchWindow/types'

function args(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) (out[argv[i].replace(/^--/, '')] ??= []).push(argv[i + 1])
  return out
}

async function main() {
  const a = args()
  const wallet = a.wallet?.[0]
  const token = a.token?.[0]
  const side = (a.side?.[0] ?? 'entry') as 'entry' | 'exit'
  const chain = (a.chain?.[0] ?? 'base') as SupportedChain
  const decimals = Number(a.decimals?.[0] ?? 18)
  if (!wallet || !token || !a.tx?.length) throw new Error('usage: --wallet 0x.. --token 0x.. --side entry|exit --tx 0x.. [--tx ..] [--amount n] [--decimals 18]')
  const fetchTx = createReceiptQuoteTxFetcher()
  const tracer = createInternalTransferTracer()
  for (const txHash of a.tx) {
    const tx = await fetchTx(chain, txHash)
    let amount = a.amount?.[0] != null ? Number(a.amount[0]) : NaN
    if (!Number.isFinite(amount) && tx.status === 'ok') {
      const wl = wallet.toLowerCase()
      const raw = tx.logs
        .filter((l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC0)
        .filter((l) => `0x${(side === 'entry' ? l.topics[2] : l.topics[1]).slice(-40)}`.toLowerCase() === wl)
        .reduce((sum, l) => sum + BigInt(l.data.slice(0, 66)), BigInt(0))
      amount = Number(raw) / 10 ** decimals
    }
    const classify = (evidence: typeof tx) => classifyReceiptQuoteEvidence({ chain, walletAddress: wallet, targetToken: token, side, targetAmount: amount, targetDecimals: decimals, tx: evidence })
    let result = classify(tx)
    let trace: unknown = null
    if (result.needsNativeRecipientProof && tx.status === 'ok') {
      const evidence = await tracer(chain, txHash)
      trace = evidence
      result = classify({ ...tx, internalTransfers: evidence.transfers, traceSource: evidence.source })
    }
    console.log(JSON.stringify({ txHash, receiptStatus: tx.status, finalClassification: result.classification, quote: result.quote, trace, forensics: result.forensics }, null, 2))
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
