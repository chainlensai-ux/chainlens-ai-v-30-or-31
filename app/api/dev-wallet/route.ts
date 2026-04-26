import { NextResponse } from 'next/server'

const ALCHEMY_BASE_URL = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}`
const COVALENT_BASE_URL = 'https://api.covalenthq.com/v1'

interface AlchemyTransfer {
  blockNum: string
  hash: string
  from: string
  to: string | null
  value: number | null
  asset: string | null
  category: string
  metadata?: { blockTimestamp?: string }
  rawContract?: { address?: string | null }
}

interface LinkedWallet {
  address: string
  amountReceived: number | null
  asset: string | null
  txHash: string | null
  firstSeen: string | null
}

interface MatchedHolder {
  address: string
  supplyPct: number
  isDeployer: boolean
  isLinked: boolean
}

interface PreviousProject {
  contractAddress: string
  name: string | null
  symbol: string | null
  createdAt: string | null
  rugFlag: boolean | null
  rugReason: string | null
}

interface ClarkVerdict {
  label: 'TRUSTWORTHY' | 'WATCH' | 'AVOID' | 'UNKNOWN' | 'SCAN DEEPER'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

interface VerdictSignalInput {
  deployerAddress: string | null
  deployerConfidence: 'high' | 'medium' | 'low'
  linkedWallets: LinkedWallet[]
  suspiciousTransfers: boolean
  holderDataAvailable: boolean
  supplyControlled: number | null
  securityDataAvailable: boolean
  liquidityDataAvailable: boolean
  honeypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  lpLocked: boolean | null
  lpLockDataAvailable: boolean
  lpHolderConcentration: number | null
  lpHolderDataAvailable: boolean
}

async function alchemyRpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(ALCHEMY_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Alchemy RPC ${res.status}`)
  const json = await res.json() as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(`Alchemy: ${json.error.message}`)
  return json.result
}

async function getAssetTransfers(params: Record<string, unknown>): Promise<AlchemyTransfer[]> {
  try {
    const result = await alchemyRpc('alchemy_getAssetTransfers', [params]) as { transfers?: AlchemyTransfer[] }
    return result?.transfers ?? []
  } catch {
    return []
  }
}

async function checkTokenMetadata(contract: string): Promise<{ metadataAvailable: boolean; source: 'goldrush' | 'none' }> {
  const apiKey = process.env.COVALENT_API_KEY
  if (!apiKey) return { metadataAvailable: false, source: 'none' }

  try {
    const res = await fetch(
      `${COVALENT_BASE_URL}/base-mainnet/tokens/${contract}/?key=${apiKey}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return { metadataAvailable: false, source: 'none' }

    const json = await res.json() as { data?: { contract_ticker_symbol?: string | null; contract_name?: string | null } }
    const exists = Boolean(json?.data?.contract_ticker_symbol || json?.data?.contract_name)
    return { metadataAvailable: exists, source: exists ? 'goldrush' : 'none' }
  } catch {
    return { metadataAvailable: false, source: 'none' }
  }
}

async function findLikelyDeployer(contract: string): Promise<{
  address: string | null
  confidence: 'high' | 'medium' | 'low'
  methodUsed: 'alchemy_first_mint_recipient' | 'alchemy_earliest_token_transfer_fallback' | 'unknown'
}> {
  const mintTransfers = await getAssetTransfers({
    fromBlock: '0x0',
    toBlock: 'latest',
    category: ['erc20'],
    contractAddresses: [contract],
    fromAddress: '0x0000000000000000000000000000000000000000',
    order: 'asc',
    maxCount: '0x64',
    withMetadata: true,
  })

  const firstMint = mintTransfers.find(t => t.to && t.to !== '0x0000000000000000000000000000000000000000')
  if (firstMint?.to) {
    return {
      address: firstMint.to.toLowerCase(),
      confidence: 'medium',
      methodUsed: 'alchemy_first_mint_recipient',
    }
  }

  const earliestTransfers = await getAssetTransfers({
    fromBlock: '0x0',
    toBlock: 'latest',
    category: ['erc20'],
    contractAddresses: [contract],
    order: 'asc',
    maxCount: '0x32',
    withMetadata: true,
  })

  const earliest = earliestTransfers.find(t => t.from || t.to)
  if (earliest) {
    const fallbackAddress =
      (earliest.from && earliest.from !== '0x0000000000000000000000000000000000000000'
        ? earliest.from
        : earliest.to) ?? null

    return {
      address: fallbackAddress?.toLowerCase() ?? null,
      confidence: 'low',
      methodUsed: 'alchemy_earliest_token_transfer_fallback',
    }
  }

  return { address: null, confidence: 'low', methodUsed: 'unknown' }
}

async function findLinkedWallets(deployer: string, excludeContract: string): Promise<LinkedWallet[]> {
  const EXCLUDED = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
    deployer.toLowerCase(),
    excludeContract.toLowerCase(),
  ])

  const transfers = await getAssetTransfers({
    fromBlock: '0x0',
    toBlock: 'latest',
    fromAddress: deployer,
    category: ['external', 'erc20'],
    order: 'desc',
    maxCount: '0x64',
    withMetadata: true,
  })

  const walletMap = new Map<string, LinkedWallet>()
  for (const t of transfers) {
    const to = t.to?.toLowerCase()
    if (!to || EXCLUDED.has(to)) continue

    if (!walletMap.has(to)) {
      walletMap.set(to, {
        address: to,
        amountReceived: t.value,
        asset: t.asset,
        txHash: t.hash,
        firstSeen: t.metadata?.blockTimestamp ?? null,
      })
      continue
    }

    const existing = walletMap.get(to)!
    existing.amountReceived = (existing.amountReceived ?? 0) + (t.value ?? 0)
    const existingTime = existing.firstSeen ? new Date(existing.firstSeen).getTime() : Number.POSITIVE_INFINITY
    const nextTime = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : Number.POSITIVE_INFINITY
    if (nextTime < existingTime) {
      existing.firstSeen = t.metadata?.blockTimestamp ?? existing.firstSeen
      existing.txHash = t.hash ?? existing.txHash
      existing.asset = existing.asset ?? t.asset
    }
  }

  return [...walletMap.values()].slice(0, 20)
}

async function getSupplyData(
  contract: string,
  deployer: string | null,
  linkedWallets: LinkedWallet[],
): Promise<{
  holderDataAvailable: boolean
  supplyControlled: number | null
  matchedHolderWallets: MatchedHolder[]
}> {
  const apiKey = process.env.COVALENT_API_KEY
  if (!apiKey) {
    return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }
  }

  try {
    const res = await fetch(
      `${COVALENT_BASE_URL}/base-mainnet/tokens/${contract}/token_holders_v2/?page-size=50&key=${apiKey}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }

    const json = await res.json() as {
      data?: {
        items?: Array<{ address: string; balance: string; total_supply?: string }>
      }
    }

    const items = json?.data?.items ?? []
    if (items.length === 0) return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }

    const totalSupplyRaw = items[0]?.total_supply ?? '0'
    const totalSupply = BigInt(totalSupplyRaw === '' ? '0' : totalSupplyRaw)

    const linkedSet = new Set(linkedWallets.map(w => w.address.toLowerCase()))
    const matched: MatchedHolder[] = []
    let controlled = 0

    for (const item of items) {
      const addr = (item.address ?? '').toLowerCase()
      const isDeployer = deployer ? addr === deployer.toLowerCase() : false
      const isLinked = linkedSet.has(addr)
      if (!isDeployer && !isLinked) continue

      let pct = 0
      if (totalSupply > BigInt(0)) {
        const bal = BigInt(item.balance ?? '0')
        pct = Number((bal * BigInt(10000)) / totalSupply) / 100
      }

      controlled += pct
      matched.push({ address: addr, supplyPct: pct, isDeployer, isLinked })
    }

    return {
      holderDataAvailable: true,
      supplyControlled: Math.round(controlled * 100) / 100,
      matchedHolderWallets: matched.sort((a, b) => b.supplyPct - a.supplyPct),
    }
  } catch {
    return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }
  }
}

async function getPreviousActivity(deployer: string | null): Promise<{
  previousActivityAvailable: boolean
  previousProjects: PreviousProject[]
  warning: string | null
}> {
  if (!deployer) {
    return {
      previousActivityAvailable: false,
      previousProjects: [],
      warning: 'Previous activity unavailable — likely deployer address could not be identified.',
    }
  }

  const transfers = await getAssetTransfers({
    fromBlock: '0x0',
    toBlock: 'latest',
    fromAddress: deployer,
    category: ['erc20', 'external'],
    order: 'desc',
    maxCount: '0x64',
    withMetadata: true,
  })

  if (transfers.length === 0) {
    return {
      previousActivityAvailable: false,
      previousProjects: [],
      warning: 'Previous activity unavailable from current Alchemy/GoldRush data.',
    }
  }

  const byContract = new Map<string, PreviousProject>()
  for (const t of transfers) {
    const contractAddress = t.rawContract?.address?.toLowerCase()
    if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') continue
    if (byContract.has(contractAddress)) continue

    byContract.set(contractAddress, {
      contractAddress,
      name: null,
      symbol: t.asset,
      createdAt: t.metadata?.blockTimestamp ?? null,
      rugFlag: null,
      rugReason: null,
    })
  }

  return {
    previousActivityAvailable: true,
    previousProjects: [...byContract.values()].slice(0, 10),
    warning: null,
  }
}

function detectSuspiciousTransfers(
  linkedWallets: LinkedWallet[],
  supplyControlled: number | null,
): { suspiciousTransfers: boolean; suspiciousTransferReasons: string[] } {
  const reasons: string[] = []

  if (linkedWallets.length >= 5) {
    reasons.push(`Likely deployer funded ${linkedWallets.length} wallets`)
  }

  const numericAmounts = linkedWallets.map(w => w.amountReceived).filter((v): v is number => typeof v === 'number')
  if (numericAmounts.length >= 3) {
    const rounded = numericAmounts.map(v => Number(v.toFixed(6)))
    const counts = new Map<number, number>()
    for (const n of rounded) counts.set(n, (counts.get(n) ?? 0) + 1)
    const maxGroup = Math.max(...counts.values())
    if (maxGroup >= 3) reasons.push('Multiple linked wallets received very similar transfer amounts')
  }

  const times = linkedWallets
    .map(w => (w.firstSeen ? new Date(w.firstSeen).getTime() : null))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)
  if (times.length >= 3 && (times[times.length - 1] - times[0]) <= 2 * 60 * 60 * 1000) {
    reasons.push('Linked wallets were funded close together in time')
  }

  if (supplyControlled !== null && supplyControlled >= 20) {
    reasons.push(`Deployer cluster controls ~${supplyControlled.toFixed(1)}% of visible holder supply`)
  }

  return { suspiciousTransfers: reasons.length > 0, suspiciousTransferReasons: reasons }
}

function computeRiskLabel(input: VerdictSignalInput): ClarkVerdict['label'] {
  const verifiedCriticalRisk =
    (input.suspiciousTransfers && input.linkedWallets.length >= 5) ||
    (input.holderDataAvailable && input.supplyControlled !== null && input.supplyControlled >= 50) ||
    (input.honeypot === true && input.securityDataAvailable) ||
    (((input.buyTax ?? 0) > 15 || (input.sellTax ?? 0) > 15) && input.securityDataAvailable) ||
    (input.lpLockDataAvailable && input.lpLocked === false) ||
    (input.lpHolderDataAvailable && input.lpHolderConcentration !== null && input.lpHolderConcentration >= 80)

  if (verifiedCriticalRisk) return 'AVOID'

  const hasUsefulSignal =
    Boolean(input.deployerAddress) ||
    input.linkedWallets.length > 0 ||
    input.deployerConfidence === 'medium' ||
    input.deployerConfidence === 'low' ||
    input.holderDataAvailable === false ||
    input.liquidityDataAvailable === false ||
    input.securityDataAvailable === false ||
    (!input.suspiciousTransfers && input.linkedWallets.length > 0)

  if (!hasUsefulSignal) {
    return 'UNKNOWN'
  }

  if (
    input.deployerAddress &&
    input.deployerConfidence === 'high' &&
    !input.suspiciousTransfers &&
    input.holderDataAvailable &&
    input.supplyControlled !== null &&
    input.supplyControlled < 20 &&
    input.liquidityDataAvailable &&
    input.securityDataAvailable
  ) {
    return 'TRUSTWORTHY'
  }

  return 'WATCH'
}

function sanitizeClarkText(
  lines: string[],
  data: { holderDataAvailable: boolean; supplyControlled: number | null; liquidityDataAvailable: boolean; securityDataAvailable: boolean }
): string[] {
  let cleaned = [...lines]

  if (!data.holderDataAvailable || data.supplyControlled === null) {
    cleaned = cleaned.map(line => {
      const lower = line.toLowerCase()
      const hasPercent = /\b\d+(\.\d+)?%/.test(line)
      const holderConcentrationClaim =
        lower.includes('holder') ||
        lower.includes('supply concentration') ||
        lower.includes('top holder') ||
        lower.includes('deployer holds') ||
        lower.includes('controls')

      if (lower.includes('100%') && lower.includes('supply')) {
        return 'Holder distribution unavailable, so supply control cannot be confirmed.'
      }
      if ((lower.includes('creator') || lower.includes('deployer')) && lower.includes('holds') && lower.includes('%')) {
        return 'Holder distribution unavailable, so supply control cannot be confirmed.'
      }
      if (hasPercent && holderConcentrationClaim) {
        return 'Holder distribution unavailable, so supply control cannot be confirmed.'
      }
      return line
    })
  }

  if (!data.liquidityDataAvailable) {
    cleaned = cleaned.map(line => {
      const lower = line.toLowerCase()
      if (
        lower.includes('no dex liquidity') ||
        lower.includes('no active pool') ||
        lower.includes('no lp lock') ||
        lower.includes('lp not locked')
      ) {
        return 'Liquidity/LP lock data unavailable from current scan.'
      }
      return line
    })
  }

  if (!data.securityDataAvailable) {
    cleaned = cleaned.map(line => {
      const lower = line.toLowerCase()
      if (
        lower.includes('honeypot') ||
        lower.includes('sell tax') ||
        lower.includes('buy tax') ||
        lower.includes('transfer tax') ||
        lower.includes('blacklist')
      ) {
        return 'Security scan unavailable from current data sources.'
      }
      return line
    })
  }

  return cleaned
}

function defaultNextAction(label: ClarkVerdict['label']): string {
  if (label === 'WATCH') return 'Watch only; verify holder distribution, LP control, and linked-wallet behavior before trusting it.'
  if (label === 'AVOID') return 'Avoid until the critical risk is resolved or verified safe.'
  if (label === 'UNKNOWN') return 'Not enough verified data to make a strong call.'
  if (label === 'SCAN DEEPER') return 'Review linked-wallet behavior and rerun the scan with fuller data.'
  return 'Monitor regularly and keep validating new wallet activity.'
}

async function getClarkVerdict(origin: string, data: {
  contractAddress: string
  deployerAddress: string | null
  deployerConfidence: 'high' | 'medium' | 'low'
  methodUsed: string
  linkedWallets: LinkedWallet[]
  supplyControlled: number | null
  holderDataAvailable: boolean
  liquidityDataAvailable: boolean
  securityDataAvailable: boolean
  previousActivityAvailable: boolean
  previousProjects: PreviousProject[]
  suspiciousTransfers: boolean
  suspiciousTransferReasons: string[]
  warnings: string[]
}): Promise<{ verdict: ClarkVerdict | null; clarkError: string | null }> {
  const normalizeLabel = (value: unknown): ClarkVerdict['label'] | null => {
    const v = String(value ?? '').trim().toUpperCase().replace(/_/g, ' ')
    if (v === 'TRUSTWORTHY' || v === 'WATCH' || v === 'AVOID' || v === 'UNKNOWN' || v === 'SCAN DEEPER') return v as ClarkVerdict['label']
    if (v === 'HIGH RISK') return 'AVOID'
    if (v === 'LOW CONFIDENCE') return 'UNKNOWN'
    if (v === 'SCAN DEEPER') return 'SCAN DEEPER'
    if (v === 'SCANDEEPER' || v === 'SCAN DEEPER') return 'SCAN DEEPER'
    return null
  }
  const normalizeConfidence = (value: unknown): ClarkVerdict['confidence'] => {
    const v = String(value ?? '').trim().toLowerCase()
    if (v === 'high') return 'high'
    if (v === 'low') return 'low'
    return 'medium'
  }
  const parseFallbackLabelFromText = (text: string): ClarkVerdict['label'] | null => {
    const m = text.match(/\bVerdict:\s*(AVOID|WATCH|SCAN DEEPER|TRUSTWORTHY|UNKNOWN)\b/i)
    return m ? normalizeLabel(m[1]) : null
  }
  const parseFallbackConfidenceFromText = (text: string): ClarkVerdict['confidence'] => {
    const m = text.match(/\bConfidence:\s*(Low|Medium|High)\b/i)
    return m ? normalizeConfidence(m[1]) : normalizeConfidence(data.deployerConfidence)
  }

  const prompt =
    `MODE: dev-wallet\n` +
    `Analyze this Base token scan and return JSON only.\n` +
    `Use only the fields below. Keep response short and professional.\n` +
    `Use wording: "likely deployer/owner wallet". Do not claim confirmed deployer unless confidence is high.\n` +
    `Do not infer supply concentration from missing holder data.\n` +
    `If holder data is unavailable, explicitly state supply control cannot be confirmed and do not mention holder percentages.\n` +
    `Do not infer LP lock status or DEX liquidity from missing liquidity data.\n` +
    `If security scan data is unavailable, do not infer honeypot status or tax values.\n` +
    `Output label must be exactly one of: TRUSTWORTHY, WATCH, AVOID, UNKNOWN.\n` +
    `Address: ${data.contractAddress}\n` +
    `Likely deployer: ${data.deployerAddress ?? 'unknown'}\n` +
    `Confidence: ${data.deployerConfidence}\n` +
    `Method: ${data.methodUsed}\n` +
    `Linked wallets: ${data.linkedWallets.length}\n` +
    `Holder data available: ${data.holderDataAvailable}\n` +
    `Supply controlled: ${data.supplyControlled ?? 'unknown'}\n` +
    `Liquidity data available: ${data.liquidityDataAvailable}\n` +
    `Security data available: ${data.securityDataAvailable}\n` +
    `Previous activity available: ${data.previousActivityAvailable}\n` +
    `Previous activity contracts: ${data.previousProjects.map(p => p.contractAddress).slice(0, 8).join(', ') || 'none'}\n` +
    `Suspicious transfers: ${data.suspiciousTransfers}\n` +
    `Suspicious reasons: ${data.suspiciousTransferReasons.join('; ') || 'none'}\n` +
    `Unavailable data: ${data.warnings.join('; ') || 'none'}\n` +
    `Return ONLY JSON with keys label, confidence, summary, keySignals, risks, nextAction.`

  try {
    const res = await fetch(`${origin}/api/clark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feature: 'clark-ai',
        mode: 'dev-wallet',
        chain: 'base',
        message: prompt,
        prompt,
        context: {
          contractAddress: data.contractAddress,
          deployerAddress: data.deployerAddress,
          deployerConfidence: data.deployerConfidence,
          linkedWallets: data.linkedWallets,
          suspiciousTransfers: data.suspiciousTransfers,
          suspiciousTransferReasons: data.suspiciousTransferReasons,
          holderDataAvailable: data.holderDataAvailable,
          supplyControlled: data.supplyControlled,
          previousProjects: data.previousProjects,
          warnings: data.warnings,
          computedVerdict: computeRiskLabel({
            deployerAddress: data.deployerAddress,
            deployerConfidence: data.deployerConfidence,
            linkedWallets: data.linkedWallets,
            suspiciousTransfers: data.suspiciousTransfers,
            holderDataAvailable: data.holderDataAvailable,
            supplyControlled: data.supplyControlled,
            securityDataAvailable: data.securityDataAvailable,
            liquidityDataAvailable: data.liquidityDataAvailable,
            honeypot: null,
            buyTax: null,
            sellTax: null,
            lpLocked: null,
            lpLockDataAvailable: false,
            lpHolderConcentration: null,
            lpHolderDataAvailable: false,
          }),
        },
      }),
      cache: 'no-store',
    })

    if (!res.ok) return { verdict: null, clarkError: 'Clark analysis failed — verify manually.' }
    const payload = await res.json() as { data?: Record<string, unknown> } | string
    const bodyData = typeof payload === 'string' ? null : (payload?.data ?? null)
    const text =
      (typeof bodyData?.reply === 'string' ? bodyData.reply : null) ??
      (typeof bodyData?.response === 'string' ? bodyData.response : null) ??
      (typeof bodyData?.message === 'string' ? bodyData.message : null) ??
      (typeof bodyData?.text === 'string' ? bodyData.text : null) ??
      (typeof payload === 'string' ? payload : '')

    const computedLabel = computeRiskLabel({
      deployerAddress: data.deployerAddress,
      deployerConfidence: data.deployerConfidence,
      linkedWallets: data.linkedWallets,
      suspiciousTransfers: data.suspiciousTransfers,
      holderDataAvailable: data.holderDataAvailable,
      supplyControlled: data.supplyControlled,
      securityDataAvailable: data.securityDataAvailable,
      liquidityDataAvailable: data.liquidityDataAvailable,
      honeypot: null,
      buyTax: null,
      sellTax: null,
      lpLocked: null,
      lpLockDataAvailable: false,
      lpHolderConcentration: null,
      lpHolderDataAvailable: false,
    })
    const labelFromField = normalizeLabel(bodyData?.verdict)
    const confidenceFromField = normalizeConfidence(bodyData?.confidence)
    const labelFromText = parseFallbackLabelFromText(text)
    const confidenceFromText = parseFallbackConfidenceFromText(text)
    const finalLabel = labelFromField ?? labelFromText ?? computedLabel
    const finalConfidence = confidenceFromField ?? confidenceFromText

    let parsed: Partial<ClarkVerdict> = {}
    const jsonMatch = text.match(/\{[\s\S]+\}/)
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]) as Partial<ClarkVerdict> } catch {}
    }

    const fallbackSignals = sanitizeClarkText([
      data.deployerAddress ? 'Likely deployer identified' : 'Likely deployer not confirmed',
      `Linked wallets detected: ${data.linkedWallets.length}`,
      data.suspiciousTransfers ? 'Suspicious transfers observed' : 'No suspicious transfer pattern confirmed',
    ], data)
    const fallbackRisks = sanitizeClarkText([
      data.holderDataAvailable ? 'Holder distribution available for review' : 'Holder distribution unavailable',
      data.liquidityDataAvailable ? 'Liquidity data available for review' : 'LP lock/control unverified',
      ...data.suspiciousTransferReasons.slice(0, 2),
    ], data)

    let summary = sanitizeClarkText([typeof parsed.summary === 'string' ? parsed.summary : 'Analysis unavailable.'], {
      holderDataAvailable: data.holderDataAvailable,
      supplyControlled: data.supplyControlled,
      liquidityDataAvailable: data.liquidityDataAvailable,
      securityDataAvailable: data.securityDataAvailable,
    })[0]
    if (text && (!summary || summary === 'Analysis unavailable.')) {
      const clean = text.replace(/\s+/g, ' ').trim()
      summary = clean.length > 220 ? `${clean.slice(0, 217)}...` : clean
    }
    if ((!data.holderDataAvailable || data.supplyControlled === null) && !summary.includes('Holder distribution unavailable')) {
      summary = `${summary} Holder distribution unavailable, so supply control cannot be confirmed.`
    }
    if (!data.liquidityDataAvailable && !summary.includes('Liquidity/LP lock data unavailable')) {
      summary = `${summary} Liquidity/LP lock data unavailable from current scan.`
    }
    if (!data.securityDataAvailable && !summary.includes('Security scan unavailable')) {
      summary = `${summary} Security scan unavailable from current data sources.`
    }
    const readOnly = summary.match(/Read:\s*([\s\S]*?)(?:\n(?:Key signals|Risks|Next action)\s*:|$)/i)?.[1]?.trim()
    if (readOnly) summary = readOnly
    const sanitizedKeySignals = sanitizeClarkText(
      Array.isArray(parsed.keySignals) ? parsed.keySignals.map(String) : fallbackSignals,
      data
    )
    const sanitizedRisks = sanitizeClarkText(
      Array.isArray(parsed.risks) ? parsed.risks.map(String) : fallbackRisks,
      data
    )

    if (!text && !labelFromField && !labelFromText) {
      return { verdict: null, clarkError: 'Clark returned unparseable response' }
    }

    return {
      verdict: {
        label: finalLabel,
        confidence: finalConfidence,
        summary,
        keySignals: sanitizedKeySignals.length > 0 ? sanitizedKeySignals : fallbackSignals,
        risks: sanitizedRisks.length > 0 ? sanitizedRisks : fallbackRisks,
        nextAction: typeof parsed.nextAction === 'string' && parsed.nextAction.trim().length > 0
          ? parsed.nextAction
          : defaultNextAction(finalLabel),
      },
      clarkError: null,
    }
  } catch {
    return { verdict: null, clarkError: 'Clark analysis failed — verify manually.' }
  }
}

export async function POST(req: Request) {
  const warnings: string[] = []

  try {
    const body = await req.json() as { contractAddress?: string }
    const { contractAddress } = body

    if (!contractAddress || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
      return NextResponse.json(
        { error: 'Invalid contract address — must be a valid EVM address (0x + 40 hex chars)' },
        { status: 400 }
      )
    }

    const normalizedAddress = contractAddress.toLowerCase()

    let bytecode: string
    try {
      bytecode = await alchemyRpc('eth_getCode', [normalizedAddress, 'latest']) as string
    } catch {
      return NextResponse.json({ error: 'Could not reach Base RPC — try again' }, { status: 502 })
    }

    if (!bytecode || bytecode === '0x') {
      return NextResponse.json(
        { error: 'No contract found at this address on Base mainnet' },
        { status: 400 }
      )
    }

    const { metadataAvailable } = await checkTokenMetadata(normalizedAddress)
    if (!metadataAvailable) {
      warnings.push('Token metadata unavailable from current GoldRush data — continuing with Alchemy transfer history.')
    }

    const { address: deployerAddress, confidence: deployerConfidence, methodUsed } =
      await findLikelyDeployer(normalizedAddress)

    if (!deployerAddress) {
      warnings.push('Could not infer likely deployer from mint or transfer history.')
    }

    let linkedWallets: LinkedWallet[] = []
    if (deployerAddress) {
      linkedWallets = await findLinkedWallets(deployerAddress, normalizedAddress)
    } else {
      warnings.push('Linked wallets unavailable — likely deployer/owner wallet is unknown.')
    }

    const { holderDataAvailable, supplyControlled, matchedHolderWallets } =
      await getSupplyData(normalizedAddress, deployerAddress, linkedWallets)
    if (!holderDataAvailable) {
      warnings.push('GoldRush holder distribution unavailable.')
    }

    const { previousActivityAvailable, previousProjects, warning: activityWarning } =
      await getPreviousActivity(deployerAddress)
    if (activityWarning) warnings.push(activityWarning)

    const previousDeploymentsAvailable = false
    const liquidityDataAvailable = false
    const securityDataAvailable = false
    warnings.push('Liquidity/LP lock data unavailable from current scan.')
    warnings.push('Security scan unavailable from current data sources.')

    const { suspiciousTransfers, suspiciousTransferReasons } =
      detectSuspiciousTransfers(linkedWallets, supplyControlled)

    const origin = new URL(req.url).origin
    const { verdict: clarkVerdict, clarkError } = await getClarkVerdict(origin, {
      contractAddress: normalizedAddress,
      deployerAddress,
      deployerConfidence,
      methodUsed,
      linkedWallets,
      supplyControlled,
      holderDataAvailable,
      liquidityDataAvailable,
      securityDataAvailable,
      previousActivityAvailable,
      previousProjects,
      suspiciousTransfers,
      suspiciousTransferReasons,
      warnings,
    })
    if (clarkError) warnings.push(`Clark: ${clarkError}`)

    return NextResponse.json({
      contractAddress: normalizedAddress,
      chain: 'base',
      deployerAddress,
      deployerConfidence,
      methodUsed,
      linkedWallets,
      holderDataAvailable,
      supplyControlled,
      matchedHolderWallets,
      previousActivityAvailable,
      previousDeploymentsAvailable,
      previousProjects,
      suspiciousTransfers,
      suspiciousTransferReasons,
      clarkVerdict,
      warnings,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[dev-wallet] fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
