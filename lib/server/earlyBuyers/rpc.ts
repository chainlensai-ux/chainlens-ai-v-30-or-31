import { createAlchemyCallBudget, type AlchemyCallBudget } from '../alchemyCallBudget'
import { RPC } from '../../rpc'
import type { EarlyBuyerChain } from './types'

export class EarlyBuyerRpcError extends Error {
  constructor(public readonly reason: string) { super(reason) }
}

export type EarlyBuyerRpc = {
  budget: AlchemyCallBudget
  call<T>(method: string, params: unknown[], options?: EarlyBuyerRpcCallOptions): Promise<T>
}

/** maxResponseBytes rejects an oversized body with `response_size_cap`. The call still counts against the budget. */
export type EarlyBuyerRpcCallOptions = { maxResponseBytes?: number }

export function createEarlyBuyerRpc(chain: EarlyBuyerChain, fetchImpl: typeof fetch = fetch, deadlineAt = Date.now() + 20_000): EarlyBuyerRpc {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2_000 })
  // Same Alchemy key aliases already accepted by providerFetchWindow/utils.ts. That module's
  // alchemyBaseUrl is private in this checkout, so reuse its provider/config convention here.
  const keys = chain === 'base'
    ? [process.env.ALCHEMY_BASE_KEY, process.env.ALCHEMY_BASE_API_KEY, process.env.BASE_ALCHEMY_API_KEY, process.env.ALCHEMY_API_KEY, process.env.NEXT_PUBLIC_ALCHEMY_BASE_KEY]
    : [process.env.ALCHEMY_ETHEREUM_KEY, process.env.ALCHEMY_ETH_KEY, process.env.ALCHEMY_ETH_API_KEY, process.env.ALCHEMY_API_KEY]
  const key = keys.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)?.trim()
  const url = RPC[chain] || (key ? `https://${chain === 'base' ? 'base' : 'eth'}-mainnet.g.alchemy.com/v2/${key}` : '')
  return {
    budget,
    async call<T>(method: string, params: unknown[], options: EarlyBuyerRpcCallOptions = {}): Promise<T> {
      if (!url) throw new EarlyBuyerRpcError('rpc_unconfigured')
      if (Date.now() >= deadlineAt) throw new EarlyBuyerRpcError('deadline')
      const allowance = budget.check(method)
      if (!allowance.allowed) throw new EarlyBuyerRpcError(allowance.reason)
      budget.record(method)
      const timeout = Math.max(1, Math.min(4_000, deadlineAt - Date.now()))
      let response: Response
      try {
        response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout), cache: 'no-store' })
      } catch { throw new EarlyBuyerRpcError('rpc_transport_failed') }
      if (!response.ok) throw new EarlyBuyerRpcError(`rpc_http_${response.status}`)
      const cap = options.maxResponseBytes
      if (cap != null && Number(response.headers.get('content-length') ?? 0) > cap) { await response.body?.cancel().catch(() => undefined); throw new EarlyBuyerRpcError('response_size_cap') }
      let payload: { result?: T; error?: unknown }
      let text: string
      try { text = await response.text() } catch { throw new EarlyBuyerRpcError('rpc_malformed_response') }
      // Compressed or chunked bodies carry no reliable content-length, so check the decoded size too.
      if (cap != null && text.length > cap) throw new EarlyBuyerRpcError('response_size_cap')
      try { payload = JSON.parse(text) as { result?: T; error?: unknown } } catch { throw new EarlyBuyerRpcError('rpc_malformed_response') }
      if (payload.error || payload.result == null) throw new EarlyBuyerRpcError('rpc_error')
      return payload.result
    },
  }
}
