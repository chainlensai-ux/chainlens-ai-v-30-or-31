// ALCHEMY FALLBACK for the whale sync. GoldRush transactions_v3 (with logs) is the primary source, but
// for an active trader one page is tens of MB and 5–15s, so a wallet sync times out or hits a 429 and
// the wallet is lost for that round ("Sync failed" on every FOMO trader added). Alchemy's
// alchemy_getAssetTransfers returns the same wallet-level transfers (ERC-20 in/out, ETH sent, ETH
// received from contracts) in well under a second.
//
// The transfers are converted into the GoldRush transaction shape the sync's decoder already reads
// (Transfer log events from/to/value + sender contract, and the native ETH value), so classification,
// mint/burn filtering, decimals rules and pricing are exactly the same code. Decimals come only from the
// token contract as Alchemy reports it; unknown decimals stay unknown (never 18).

export type AlchemyTransfer = {
  hash?: string
  from?: string | null
  to?: string | null
  asset?: string | null
  category?: string
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | null }
  metadata?: { blockTimestamp?: string }
}

export type GoldRushLikeTx = {
  tx_hash: string
  block_signed_at: string
  successful: boolean
  from_address: string | null
  to_address: string | null
  value: string
  log_events: Array<{
    sender_address: string
    sender_contract_ticker_symbol: string | null
    sender_contract_decimals: number | null
    decoded: { name: 'Transfer'; params: Array<{ name: string; value: string }> }
  }>
}

const hexToDecimalString = (hex: string | null | undefined): string | null => {
  if (!hex || !/^0x[0-9a-f]+$/i.test(hex)) return null
  try { return BigInt(hex).toString() } catch { return null }
}

/** Groups one wallet's transfers into one GoldRush-shaped transaction per hash. */
export function alchemyTransfersToTxs(wallet: string, transfers: readonly AlchemyTransfer[]): GoldRushLikeTx[] {
  const me = wallet.toLowerCase()
  const byHash = new Map<string, { tx: GoldRushLikeTx; nativeIn: bigint; nativeOut: bigint; seen: Set<string> }>()
  for (const t of transfers) {
    const hash = t.hash?.toLowerCase()
    const at = t.metadata?.blockTimestamp
    if (!hash || !at || !Number.isFinite(Date.parse(at))) continue
    const from = t.from?.toLowerCase() ?? ''
    const to = t.to?.toLowerCase() ?? ''
    if (from !== me && to !== me) continue
    let entry = byHash.get(hash)
    if (!entry) {
      entry = { tx: { tx_hash: hash, block_signed_at: at, successful: true, from_address: null, to_address: null, value: '0', log_events: [] }, nativeIn: BigInt(0), nativeOut: BigInt(0), seen: new Set() }
      byHash.set(hash, entry)
    }
    const raw = hexToDecimalString(t.rawContract?.value)
    if (raw == null || raw === '0') continue
    // Alchemy can report the same transfer under two categories; count each once.
    const dedupeKey = `${t.category}:${from}:${to}:${t.rawContract?.address ?? 'native'}:${raw}`
    if (entry.seen.has(dedupeKey)) continue
    entry.seen.add(dedupeKey)
    if (t.category === 'external' || t.category === 'internal') {
      if (to === me) entry.nativeIn += BigInt(raw)
      if (from === me) entry.nativeOut += BigInt(raw)
      continue
    }
    if (t.category !== 'erc20') continue
    const token = t.rawContract?.address?.toLowerCase()
    if (!token) continue
    const decimalsText = hexToDecimalString(t.rawContract?.decimal)
    const decimals = decimalsText == null ? null : Number(decimalsText)
    entry.tx.log_events.push({
      sender_address: token,
      sender_contract_ticker_symbol: t.asset ?? null,
      sender_contract_decimals: decimals != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
      decoded: { name: 'Transfer', params: [{ name: 'from', value: from }, { name: 'to', value: to }, { name: 'value', value: raw }] },
    })
  }
  const txs: GoldRushLikeTx[] = []
  for (const { tx, nativeIn, nativeOut } of byHash.values()) {
    // Native ETH as the decoder reads it: the net direction for this wallet in this transaction.
    const net = nativeIn - nativeOut
    if (net > BigInt(0)) { tx.value = net.toString(); tx.to_address = me; tx.from_address = null }
    else if (net < BigInt(0)) { tx.value = (-net).toString(); tx.from_address = me; tx.to_address = null }
    if (tx.log_events.length > 0 || tx.value !== '0') txs.push(tx)
  }
  return txs.sort((a, b) => Date.parse(b.block_signed_at) - Date.parse(a.block_signed_at))
}

/** Both directions since `fromBlock`, newest first, one bounded page each. Throws on any failure. */
export async function fetchAlchemyWalletTxs(
  wallet: string,
  fromBlock: number,
  opts: { rpcUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxCount?: number },
): Promise<GoldRushLikeTx[]> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const page = async (filter: Record<string, string>): Promise<AlchemyTransfer[]> => {
    const res = await fetchImpl(opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [{
        fromBlock: `0x${fromBlock.toString(16)}`, toBlock: 'latest', category: ['external', 'erc20', 'internal'],
        withMetadata: true, excludeZeroValue: true, order: 'desc', maxCount: `0x${(opts.maxCount ?? 1000).toString(16)}`, ...filter,
      }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    })
    if (!res.ok) throw new Error(`alchemy_http_${res.status}`)
    const json = await res.json() as { result?: { transfers?: AlchemyTransfer[] }; error?: { message?: string } }
    if (json.error || !Array.isArray(json.result?.transfers)) throw new Error('alchemy_rpc_error')
    return json.result.transfers
  }
  const me = wallet.toLowerCase()
  const [out, inn] = await Promise.all([page({ fromAddress: me }), page({ toAddress: me })])
  return alchemyTransfersToTxs(me, [...out, ...inn])
}
