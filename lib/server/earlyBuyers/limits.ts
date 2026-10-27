import { kv } from '@vercel/kv'
import type { UserPlan } from '../../pricingPlans'

const GLOBAL_DAILY_CU_CAP = 200_000
const RESERVED_CU = 2_000
const USER_DAILY_LIMIT: Record<UserPlan, number> = { free: 0, pro: 20, elite: 60 }
export function earlyBuyerQuotaPolicy(plan: UserPlan): { userDailyAnalyses: number; globalDailyCu: number; reservedCuPerAnalysis: number } {
  return { userDailyAnalyses: USER_DAILY_LIMIT[plan], globalDailyCu: GLOBAL_DAILY_CU_CAP, reservedCuPerAnalysis: RESERVED_CU }
}
const configured = () => Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
const utcDay = () => new Date().toISOString().slice(0, 10)

export type EarlyBuyerReservation = { allowed: true; settle(actualCu: number): Promise<void> } | { allowed: false; reason: string }

/** Cached evidence may refresh current holdings without consuming a new-analysis quota. */
export async function reserveEarlyBuyerHoldings(chain: string, token: string): Promise<EarlyBuyerReservation> {
  if (!configured()) return { allowed: false, reason: 'quota_store_unavailable' }
  const globalKey = `early-buyers:global-cu:${utcDay()}`
  const lockKey = `early-buyers:holdings-lock:${chain}:${token.toLowerCase()}`
  const nonce = crypto.randomUUID()
  const reserved = 26 // one Multicall3 eth_call covers at most fifty balanceOf reads
  let outcome: unknown
  try {
    outcome = await kv.eval(`
      if redis.call('EXISTS', KEYS[2]) == 1 then return 'locked' end
      if tonumber(redis.call('GET', KEYS[1]) or '0') + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return 'global_cu_cap' end
      redis.call('SET', KEYS[2], ARGV[3], 'EX', 45)
      redis.call('INCRBY', KEYS[1], ARGV[1]); redis.call('EXPIRE', KEYS[1], 172800)
      return 'ok'
    `, [globalKey, lockKey], [reserved, GLOBAL_DAILY_CU_CAP, nonce])
  } catch { return { allowed: false, reason: 'quota_store_unavailable' } }
  if (outcome !== 'ok') return { allowed: false, reason: String(outcome || 'quota_store_unavailable') }
  return { allowed: true, async settle(actualCu: number) {
    const refund = reserved - Math.max(0, Math.min(reserved, Math.ceil(Number.isFinite(actualCu) ? actualCu : reserved)))
    try { await kv.eval(`
      if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[2]); if tonumber(ARGV[2]) > 0 then redis.call('DECRBY', KEYS[1], ARGV[2]) end
      return 1
    `, [globalKey, lockKey], [nonce, refund]) } catch { /* conservatively retain quota */ }
  } }
}

/** One Redis script reserves user count, global CU, user lock and cross-worker token lock atomically. */
export async function reserveEarlyBuyerAnalysis(userId: string, plan: UserPlan, chain: string, token: string, testing?: { evalScript: (script: string, keys: string[], args: Array<string | number>) => Promise<unknown> }): Promise<EarlyBuyerReservation> {
  const limit = USER_DAILY_LIMIT[plan]
  if (limit === 0) return { allowed: false, reason: 'free_cached_only' }
  if (!configured() && !testing) return { allowed: false, reason: 'quota_store_unavailable' }
  const evalScript = testing?.evalScript ?? ((script: string, keys: string[], args: Array<string | number>) => kv.eval(script, keys, args))
  const day = utcDay()
  const userKey = `early-buyers:user:${day}:${userId}`
  const globalKey = `early-buyers:global-cu:${day}`
  const lockKey = `early-buyers:lock:${userId}`
  const tokenLockKey = `early-buyers:analysis-lock:v2:${chain}:${token.toLowerCase()}`
  const lockValue = `${chain}:${token.toLowerCase()}:${crypto.randomUUID()}`
  const reserveScript = `
    if redis.call('EXISTS', KEYS[3]) == 1 then return 'locked' end
    if redis.call('EXISTS', KEYS[4]) == 1 then return 'token_in_progress' end
    if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 'user_quota' end
    if tonumber(redis.call('GET', KEYS[2]) or '0') + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return 'global_cu_cap' end
    redis.call('SET', KEYS[3], ARGV[4], 'EX', 60)
    redis.call('SET', KEYS[4], ARGV[4], 'EX', 60)
    redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], 172800)
    redis.call('INCRBY', KEYS[2], ARGV[2]); redis.call('EXPIRE', KEYS[2], 172800)
    return 'ok'
  `
  let outcome: unknown
  try { outcome = await evalScript(reserveScript, [userKey, globalKey, lockKey, tokenLockKey], [limit, RESERVED_CU, GLOBAL_DAILY_CU_CAP, lockValue]) }
  catch { return { allowed: false, reason: 'quota_store_unavailable' } }
  if (outcome !== 'ok') return { allowed: false, reason: String(outcome || 'quota_store_unavailable') }
  return {
    allowed: true,
    async settle(actualCu: number) {
      const used = Number.isFinite(actualCu) ? Math.max(0, Math.min(RESERVED_CU, Math.ceil(actualCu))) : RESERVED_CU
      const refund = RESERVED_CU - used
      try {
        await evalScript(`
          if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
          redis.call('DEL', KEYS[2])
          if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
          if tonumber(ARGV[2]) > 0 then redis.call('DECRBY', KEYS[1], ARGV[2]) end
          return 1
        `, [globalKey, lockKey, tokenLockKey], [lockValue, refund])
      } catch { /* keep the conservative reservation until TTL; never overrun global cap */ }
    },
  }
}
