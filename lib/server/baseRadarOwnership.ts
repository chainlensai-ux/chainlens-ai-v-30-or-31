// lib/server/baseRadarOwnership.ts — Base Radar's own, independent ownership/admin fallback.
//
// DEV/DEPLOYER-OPEN-CHECK, DISCLOSED (reported: the drawer's "Ownership/admin" tile showed "Open
// Check / Not verified" even for tokens whose deployer identity WAS resolved — reading broken/
// unfinished rather than "genuinely unknown"). Token Scanner's own devOwnership resolution (proxy-
// admin slots, AccessControl roles, etc.) lives entirely inside the off-limits engine
// (app/api/token/route.ts) and is not touched here. This is a separate, much narrower, Base-Radar-
// owned fallback: a single read-only eth_call to owner() (selector 0x8da5cb5b, the standard
// OpenZeppelin Ownable getter — the EXACT same selector Token Scanner's own engine already reads for
// this same purpose, see its own disclosed "ownerCheck" RPC call), via the same RPC client every
// other Base Radar LP check already uses (lib/server/lpProof.ts). Used ONLY when Token Scanner's own
// resolver genuinely found nothing (ownershipVerified !== true) — never overriding a real answer it
// DID find. A revert/empty result means "no owner() function detected", reported as its own honest,
// distinct fact — never claimed as full verification that no privileged control exists at all (other
// admin patterns Token Scanner's fuller analysis checks, like AccessControl roles or proxy-admin
// slots, are not covered by this one selector probe).
import { fetchOnchainOwner, type LpChain } from './lpProof.ts'

export type BaseRadarOwnershipStatus = 'active_owner' | 'renounced' | 'no_owner_function_detected' | 'open_check'

export interface BaseRadarOwnershipFallback {
  ownershipVerified: boolean
  isRenounced: boolean
  ownerAddress: string | null
  ownershipStatus: BaseRadarOwnershipStatus
  ownershipLabel: string
  source: 'rpc_owner_call'
}

const OWNERSHIP_CACHE_TTL_MS = 15 * 60_000
const OWNERSHIP_UNAVAILABLE_TTL_MS = 60_000
const ownershipCache = new Map<string, { value: BaseRadarOwnershipFallback | null; expiresAt: number }>()

export async function resolveBaseRadarOwnershipFallback(chain: LpChain, tokenAddress: string): Promise<BaseRadarOwnershipFallback | null> {
  const key = `${chain}:${tokenAddress.toLowerCase()}`
  const cached = ownershipCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const result = await fetchOnchainOwner(chain, tokenAddress)
  let value: BaseRadarOwnershipFallback | null
  let ttl = OWNERSHIP_CACHE_TTL_MS

  if (result.status === 'active') {
    value = {
      ownershipVerified: true,
      isRenounced: false,
      ownerAddress: result.ownerAddress,
      ownershipStatus: 'active_owner',
      ownershipLabel: 'Active owner/admin detected (on-chain owner() read)',
      source: 'rpc_owner_call',
    }
  } else if (result.status === 'renounced') {
    value = {
      ownershipVerified: true,
      isRenounced: true,
      ownerAddress: null,
      ownershipStatus: 'renounced',
      ownershipLabel: 'Renounced ownership (on-chain owner() read)',
      source: 'rpc_owner_call',
    }
  } else if (result.status === 'no_owner_function') {
    // Deliberately NOT marked ownershipVerified — this proves only that the standard Ownable
    // owner() getter is absent, not that no privileged admin control exists via a different pattern.
    value = {
      ownershipVerified: false,
      isRenounced: false,
      ownerAddress: null,
      ownershipStatus: 'no_owner_function_detected',
      ownershipLabel: 'No owner() function detected — standard Ownable admin pattern not present',
      source: 'rpc_owner_call',
    }
  } else {
    // RPC unreachable/not configured for this chain — genuinely unknown, cache briefly so a real
    // outage doesn't get treated as a long-lived negative result.
    value = null
    ttl = OWNERSHIP_UNAVAILABLE_TTL_MS
  }

  ownershipCache.set(key, { value, expiresAt: Date.now() + ttl })
  return value
}
