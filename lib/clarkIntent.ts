export type ClarkIntentCategory =
  | 'base_radar'
  | 'wallet_scan'
  | 'token_scan'
  | 'liquidity_scan'
  | 'whale_alerts'
  | 'portfolio'
  | 'explain_current_page'
  | 'general_help'

export type ClarkIntentContext = {
  route?: string | null
  chain?: string | null
  selectedToken?: string | { address?: string | null; contract?: string | null } | null
  selectedWallet?: string | { address?: string | null } | null
  baseRadarSummary?: unknown
  whaleSyncStatus?: string | null
  currentTool?: string | null
}

export type ClarkResolvedIntent = {
  intent: ClarkIntentCategory
  normalized: string
  chain: 'base' | 'ethereum' | 'bnb' | 'polygon' | 'auto'
  address: string | null
  addressKind: 'wallet' | 'token' | 'unknown' | null
  source: 'message' | 'context' | 'none'
  cta: Array<{ label: string; href: string; requiresInput?: boolean }>
}

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/

function ctxAddress(v: unknown): string | null {
  if (typeof v === 'string') return v.match(ADDRESS_RE)?.[0] ?? null
  if (v && typeof v === 'object') {
    const r = v as Record<string, unknown>
    return (typeof r.address === 'string' ? r.address : typeof r.contract === 'string' ? r.contract : '').match(ADDRESS_RE)?.[0] ?? null
  }
  return null
}

function normalizeClarkMessage(message: string): string {
  return message
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9.$'\s-]/g, ' ')
    .replace(/\bbse\b/g, 'base')
    .replace(/\bwhts\b|\bwats\b|\bwhats\b/g, "what's")
    .replace(/\bwalet\b|\bwallt\b/g, 'wallet')
    .replace(/\bliq\b/g, 'liquidity')
    .replace(/\bsmartmoney\b/g, 'smart money')
    .replace(/\s+/g, ' ')
    .trim()
}

function detectChain(t: string, context?: ClarkIntentContext): ClarkResolvedIntent['chain'] {
  if (/\b(bnb|bsc|binance)\b/.test(t)) return 'bnb'
  if (/\b(eth|ethereum|mainnet)\b/.test(t)) return 'ethereum'
  if (/\b(poly|polygon|matic)\b/.test(t)) return 'polygon'
  if (/\b(base|bse)\b/.test(t)) return 'base'
  const c = String(context?.chain ?? '').toLowerCase()
  if (c === 'eth') return 'ethereum'
  if (c === 'bnb' || c === 'polygon' || c === 'base' || c === 'ethereum') return c
  return 'auto'
}

export function resolveClarkIntent(message: string, context?: ClarkIntentContext): ClarkResolvedIntent {
  const normalized = normalizeClarkMessage(message)
  const address = message.match(ADDRESS_RE)?.[0] ?? null
  const selectedToken = ctxAddress(context?.selectedToken)
  const selectedWallet = ctxAddress(context?.selectedWallet)
  const chain = detectChain(normalized, context)

  const pumping = /\b(what'?s?\s+pump(?:ing)?|what\s+pump(?:ing)?|pumps?|pumpin|moving|movers?|gainers?|runners?|new pools?|new tokens?|trending|hot tokens?|base movers?)\b/.test(normalized)
  const wallet = /\b(scan\s+(?:this\s+)?wallet|wallet\s+(?:scan|check|report|analysis)|pnl|holdings?|portfolio|copy\s*trade|0x[a-f0-9]{40}\s+wallet)\b/.test(normalized)
  const lp = /\b(liquidity|lp|lock(?:ed)?|burn(?:ed|t)?|rug\s*pull\s*lp|elite\s*lp|pool\s+(?:safety|model|depth|control))\b/.test(normalized)
  const whale = /\b(whales?|big wallets?|large wallets?|wallet alerts?|whale alerts?|smart money|large buys?|large sells?|accumulation|distribution)\b/.test(normalized)
  const page = /\b(what page am i on|explain this|what does this mean|what am i looking at|current page)\b/.test(normalized)
  const token = /\b(scan token|check token|token contract|contract|ca\b|is this coin safe|is this token safe|rug|honeypot|tax)\b/.test(normalized)

  let intent: ClarkIntentCategory = 'general_help'
  let source: ClarkResolvedIntent['source'] = 'none'
  let addressKind: ClarkResolvedIntent['addressKind'] = null
  let resolvedAddress = address

  if (pumping) intent = 'base_radar'
  else if (lp) { intent = 'liquidity_scan'; if (!resolvedAddress && selectedToken) { resolvedAddress = selectedToken; source = 'context' } }
  else if (whale) intent = 'whale_alerts'
  else if (wallet || (address && (/wallet|scan this|scan 0x|pnl|holdings|portfolio/.test(normalized) || normalized === address.toLowerCase()))) { intent = /portfolio|holdings/.test(normalized) ? 'portfolio' : 'wallet_scan'; if (!resolvedAddress && selectedWallet) { resolvedAddress = selectedWallet; source = 'context' } }
  else if (page) intent = 'explain_current_page'
  else if (token || address) { intent = 'token_scan'; if (!resolvedAddress && selectedToken) { resolvedAddress = selectedToken; source = 'context' } }
  else if (/\bscan this\b/.test(normalized) && selectedWallet) { intent = 'wallet_scan'; resolvedAddress = selectedWallet; source = 'context' }

  if (source === 'none' && resolvedAddress) source = address ? 'message' : 'context'
  if (intent === 'wallet_scan' || intent === 'portfolio') addressKind = resolvedAddress ? 'wallet' : null
  if (intent === 'token_scan' || intent === 'liquidity_scan') addressKind = resolvedAddress ? 'token' : null
  if (address && !addressKind) addressKind = 'unknown'

  const q = resolvedAddress ? `?address=${resolvedAddress}&chain=${chain}` : ''
  const cta = intent === 'base_radar' ? [{ label: 'Open Base Radar', href: '/terminal/base-radar' }, { label: 'Scan top token', href: '/terminal/token-scanner' }]
    : intent === 'wallet_scan' || intent === 'portfolio' ? [{ label: 'Scan Wallet', href: `/terminal/wallet-scanner${q || '?chain=auto'}`, requiresInput: !resolvedAddress }]
    : intent === 'liquidity_scan' ? [{ label: 'Run LP Check', href: `/terminal/liquidity${q}`, requiresInput: !resolvedAddress }, { label: 'Scan Token', href: `/terminal/token-scanner${q}`, requiresInput: !resolvedAddress }]
    : intent === 'whale_alerts' ? [{ label: 'Open Whale Alerts', href: '/terminal/whale-alerts' }]
    : intent === 'token_scan' ? [{ label: 'Scan Token', href: `/terminal/token-scanner${q}`, requiresInput: !resolvedAddress }]
    : [{ label: 'Open CORTEX Terminal', href: '/terminal' }]

  return { intent, normalized, chain, address: resolvedAddress, addressKind, source, cta }
}
