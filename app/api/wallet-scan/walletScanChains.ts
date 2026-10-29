import { SUPPORTED_CHAINS } from '@/src/pipeline/types'

const MAX_REQUESTED_CHAINS = 16

// The EVM chains the worker's preflight accepts (src/deployment/validator.ts). Checked here, before any quota or
// job: an unchecked list (only 'robinhood', a typo, 'BASE') used to be enqueued and fail in the worker after a
// deep-scan unit was already spent. 'ethereum' is the worker's own alias for 'eth'. `null` = not a valid list.
export function normalizeRequestedEvmChains(raw: string[]): string[] | null {
  if (raw.length > MAX_REQUESTED_CHAINS) return null
  const chains: string[] = []
  for (const value of raw) {
    const chain = value.trim().toLowerCase()
    if (chain === 'robinhood') continue
    const slug = chain === 'ethereum' ? 'eth' : chain
    if (!(SUPPORTED_CHAINS as string[]).includes(slug)) return null
    if (!chains.includes(slug)) chains.push(slug)
  }
  return chains.length ? chains : null
}
