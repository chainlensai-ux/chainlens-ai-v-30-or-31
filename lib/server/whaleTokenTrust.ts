// Token trust for whale feed rows. Two evidence-based cases where a row cannot have a real USD
// value and must not look like an ordinary "price missing" transfer:
//  - spoofed_stablecoin: the row claims a stablecoin ticker (USDC, USDT, …) but its contract is not
//    that stablecoin's canonical Base contract — the classic fake-USDC / address-poisoning token;
//  - spam_airdrop: the ticker is a URL / call-to-action (e.g. "WWW.AFOMO.TOP✅"), the signature of
//    unsolicited scam airdrops.
// Contract addresses are authoritative; symbols alone never make a token "real".

export type WhaleTokenRisk = 'spoofed_stablecoin' | 'spam_airdrop'

// Canonical Base mainnet stablecoin contracts (lowercase), by ticker.
const CANONICAL_BASE_STABLES: Record<string, ReadonlySet<string>> = {
  USDC: new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']),
  USDBC: new Set(['0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca']),
  DAI: new Set(['0x50c5725949a6f0c72e6c4a641f24049a917db0cb']),
  EURC: new Set(['0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42']),
  USDT: new Set(['0xfde4c96c8593536e31f229ea8f37b2ada2699bb2']),
}

const SPAM_SYMBOL_RE = /(https?:|www\.|t\.me\/|\.(com|top|io|xyz|net|org|app|site|vip|cc|club|live|gift|claim)\b|claim|visit|reward|airdrop|[✅✔☑])/i

/** Risk for one token leg, or null when nothing indicates a fake/spam token. */
export function tokenRisk(tokenAddress: unknown, symbol: unknown): WhaleTokenRisk | null {
  const sym = typeof symbol === 'string' ? symbol.trim() : ''
  if (!sym) return null
  if (SPAM_SYMBOL_RE.test(sym)) return 'spam_airdrop'
  const canonical = CANONICAL_BASE_STABLES[sym.toUpperCase()]
  const address = typeof tokenAddress === 'string' ? tokenAddress.trim().toLowerCase() : ''
  if (canonical && /^0x[0-9a-f]{40}$/.test(address) && !canonical.has(address)) return 'spoofed_stablecoin'
  return null
}

export function tokenRiskLabel(risk: WhaleTokenRisk): string {
  return risk === 'spoofed_stablecoin'
    ? 'Unverified token: uses a stablecoin ticker but is not the real contract — no USD value'
    : 'Likely spam airdrop token — no USD value'
}
