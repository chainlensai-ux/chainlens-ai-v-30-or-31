// Contract-creation lookups through Etherscan's unified V2 API. Etherscan retired the per-chain V1 hosts
// (api.basescan.org/api and friends): they still answer HTTP 200 but with status "0" and a "deprecated V1
// endpoint" message, which the callers read as "no creation record" and so fell through to the inferred
// earliest-transfer deployer. Base now goes through V2 with chainid 8453 like ETH and BNB already did.
export const ETHERSCAN_V2_API = 'https://api.etherscan.io/v2/api'

export const CREATION_LOOKUP_CHAIN_ID = { eth: '1', base: '8453', bnb: '56', robinhood: '4663' } as const

// V2 keys are issued on etherscan.io; a key made on basescan.org is only used when no Etherscan key is set.
export function creationLookupApiKey(chain: keyof typeof CREATION_LOOKUP_CHAIN_ID): string | null {
  if (chain === 'base') return process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY || null
  return process.env.ETHERSCAN_API_KEY || null
}

export function creationLookupUrl(chain: keyof typeof CREATION_LOOKUP_CHAIN_ID, address: string, apiKey: string): string {
  return `${ETHERSCAN_V2_API}?chainid=${CREATION_LOOKUP_CHAIN_ID[chain]}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${apiKey}`
}

// Why a status "0" answer carried no creator, as a fixed code safe for diagnostics (the explorer's own text is
// never echoed: it can include the request URL).
export type CreationLookupMiss =
  | 'api_no_result' | 'deprecated_endpoint' | 'plan_not_supported' | 'invalid_api_key' | 'rate_limited'

export function classifyCreationLookupMiss(json: unknown): CreationLookupMiss {
  const j = json as { message?: unknown; result?: unknown } | null
  const text = `${typeof j?.message === 'string' ? j.message : ''} ${typeof j?.result === 'string' ? j.result : ''}`.toLowerCase()
  if (text.includes('deprecated')) return 'deprecated_endpoint'
  if (text.includes('invalid api key') || text.includes('missing/invalid api key')) return 'invalid_api_key'
  if (text.includes('rate limit')) return 'rate_limited'
  if (text.includes('not supported') || text.includes('upgrade') || text.includes('free api access')) return 'plan_not_supported'
  return 'api_no_result'
}
