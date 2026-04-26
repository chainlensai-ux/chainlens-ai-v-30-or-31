import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const ALCHEMY_BASE_URL = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}`
const COVALENT_BASE_URL = 'https://api.covalenthq.com/v1'

// ─── Types ────────────────────────────────────────────────────────────────

interface AlchemyTransfer {
  blockNum: string
  hash: string
  from: string
  to: string | null
  value: number | null
  asset: string | null
  category: string
  metadata?: { blockTimestamp?: string }
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
  label: 'TRUSTWORTHY' | 'WATCH' | 'AVOID' | 'UNKNOWN'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

// ─── Alchemy RPC helper ───────────────────────────────────────────────────

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

// ─── Step 1 — Find likely deployer ───────────────────────────────────────
// We cannot confirm the true deployer without a block explorer (no API key
// configured). Instead, we identify the most frequent `from` address among
// the earliest transactions *involving* this contract. This is a heuristic,
// not a cryptographic guarantee — confidence is always "medium" at best.

async function findDeployer(contract: string): Promise<{
  address: string | null
  confidence: 'high' | 'medium' | 'low'
  methodUsed: 'earliest_transfer_fallback' | 'unknown'
}> {
  const transfers = await getAssetTransfers({
    fromBlock: '0x0',
    toBlock: 'latest',
    toAddress: contract,
    category: ['external', 'internal', 'erc20'],
    order: 'asc',
    maxCount: '0xa',
    withMetadata: true,
  })

  if (transfers.length === 0) {
    return { address: null, confidence: 'low', methodUsed: 'unknown' }
  }

  const fromCounts = new Map<string, number>()
  for (const t of transfers) {
    if (t.from) {
      const key = t.from.toLowerCase()
      fromCounts.set(key, (fromCounts.get(key) ?? 0) + 1)
    }
  }

  const topFrom = [...fromCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  const address = topFrom?.[0] ?? transfers[0]?.from?.toLowerCase() ?? null

  return { address, confidence: 'medium', methodUsed: 'earliest_transfer_fallback' }
}

// ─── Step 2 — Linked wallets ──────────────────────────────────────────────

async function findLinkedWallets(
  deployer: string,
  excludeContract: string,
): Promise<LinkedWallet[]> {
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
    category: ['external'],
    order: 'asc',
    maxCount: '0x32',
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
    } else {
      const existing = walletMap.get(to)!
      existing.amountReceived = (existing.amountReceived ?? 0) + (t.value ?? 0)
    }
  }

  return [...walletMap.values()]
    .sort((a, b) => (b.amountReceived ?? 0) - (a.amountReceived ?? 0))
    .slice(0, 20)
}

// ─── Step 3 — Supply distribution ────────────────────────────────────────

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
    if (!res.ok) {
      return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }
    }

    const json = await res.json() as {
      data?: {
        items?: Array<{ address: string; balance: string; total_supply?: string }>
      }
    }

    const items = json?.data?.items ?? []
    if (items.length === 0) {
      return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }
    }

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

// ─── Step 4 — Previous projects ───────────────────────────────────────────
// A block explorer API key is required to enumerate past contract
// deployments. Without one we return an honest empty result.

function getPreviousProjectsResult(): {
  previousDeploymentsAvailable: boolean
  previousProjects: PreviousProject[]
} {
  return { previousDeploymentsAvailable: false, previousProjects: [] }
}

// ─── Step 5 — Suspicious transfer detection ───────────────────────────────

function detectSuspiciousTransfers(
  linkedWallets: LinkedWallet[],
  supplyControlled: number | null,
): { suspiciousTransfers: boolean; suspiciousTransferReasons: string[] } {
  const reasons: string[] = []

  if (linkedWallets.length > 5) {
    reasons.push(`Deployer funded ${linkedWallets.length} separate wallets — broad pre-launch distribution`)
  } else if (linkedWallets.length > 2) {
    reasons.push(`Deployer sent funds to ${linkedWallets.length} separate wallets`)
  }

  if (supplyControlled !== null && supplyControlled > 50) {
    reasons.push(`Deployer + linked wallets control ~${supplyControlled.toFixed(1)}% of supply — extreme concentration`)
  } else if (supplyControlled !== null && supplyControlled > 20) {
    reasons.push(`Deployer + linked wallets hold ~${supplyControlled.toFixed(1)}% of supply — elevated concentration`)
  }

  // Check coordinated funding (multiple wallets funded within 1 hour)
  const timestamps = linkedWallets
    .filter(w => w.firstSeen !== null)
    .map(w => new Date(w.firstSeen!).getTime())
    .sort((a, b) => a - b)

  if (timestamps.length >= 3) {
    const windowMs = timestamps[timestamps.length - 1] - timestamps[0]
    if (windowMs < 60 * 60 * 1000) {
      reasons.push(`${timestamps.length} wallets funded within a 1-hour window — coordinated distribution pattern`)
    }
  }

  return { suspiciousTransfers: reasons.length > 0, suspiciousTransferReasons: reasons }
}

// ─── Step 6 — Clark verdict ───────────────────────────────────────────────

async function getClarkVerdict(data: {
  contractAddress: string
  deployerAddress: string | null
  deployerConfidence: string
  linkedWallets: LinkedWallet[]
  supplyControlled: number | null
  holderDataAvailable: boolean
  previousProjects: PreviousProject[]
  suspiciousTransfers: boolean
  suspiciousTransferReasons: string[]
}): Promise<{ verdict: ClarkVerdict | null; clarkError: string | null }> {
  const prompt =
    `You are Clark — ChainLens AI's onchain security analyst. Analyze this dev wallet scan and return a verdict.\n\n` +
    `CONTRACT: ${data.contractAddress}\n` +
    `CHAIN: Base\n` +
    `DEPLOYER: ${data.deployerAddress ?? 'Unknown'} (confidence: ${data.deployerConfidence})\n` +
    `LINKED WALLETS: ${data.linkedWallets.length} wallet(s) received ETH from deployer\n` +
    (data.linkedWallets.length > 0
      ? `TOP RECIPIENTS: ${data.linkedWallets.slice(0, 3).map(w => `${w.address.slice(0, 8)}… (${w.amountReceived?.toFixed(4) ?? '?'} ${w.asset ?? 'ETH'})`).join(', ')}\n`
      : '') +
    `SUPPLY CONTROLLED: ${data.supplyControlled !== null ? `${data.supplyControlled.toFixed(1)}%` : 'Unknown (holder data unavailable)'}\n` +
    `SUSPICIOUS ACTIVITY: ${data.suspiciousTransfers}\n` +
    (data.suspiciousTransferReasons.length > 0
      ? `SUSPICIOUS REASONS: ${data.suspiciousTransferReasons.join('; ')}\n`
      : '') +
    `PREVIOUS PROJECTS: deployment history unavailable (no block explorer key)\n\n` +
    `Return ONLY a valid JSON object. No markdown, no code fences:\n\n` +
    `{\n` +
    `  "label": "TRUSTWORTHY" | "WATCH" | "AVOID" | "UNKNOWN",\n` +
    `  "confidence": "high" | "medium" | "low",\n` +
    `  "summary": "2-3 sentence verdict referencing actual data points",\n` +
    `  "keySignals": ["signal 1", "signal 2"],\n` +
    `  "risks": ["risk 1", "risk 2"],\n` +
    `  "nextAction": "One clear recommended action"\n` +
    `}\n\n` +
    `Rules: low-confidence deployer data → UNKNOWN or WATCH, not TRUSTWORTHY. ` +
    `supply >30% → WATCH or AVOID. linked wallets >5 → WATCH or AVOID. ` +
    `Be concise and data-driven.`

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : ''
    const jsonMatch = text.match(/\{[\s\S]+\}/)
    if (!jsonMatch) return { verdict: null, clarkError: 'Clark returned unparseable response' }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<ClarkVerdict>
    const LABELS = ['TRUSTWORTHY', 'WATCH', 'AVOID', 'UNKNOWN'] as const
    const CONFS  = ['high', 'medium', 'low'] as const

    const verdict: ClarkVerdict = {
      label:      LABELS.includes(parsed.label as 'TRUSTWORTHY') ? parsed.label as ClarkVerdict['label'] : 'UNKNOWN',
      confidence: CONFS.includes(parsed.confidence as 'high') ? parsed.confidence as ClarkVerdict['confidence'] : 'low',
      summary:    typeof parsed.summary === 'string' ? parsed.summary : 'Analysis unavailable.',
      keySignals: Array.isArray(parsed.keySignals) ? parsed.keySignals.map(String) : [],
      risks:      Array.isArray(parsed.risks)       ? parsed.risks.map(String)       : [],
      nextAction: typeof parsed.nextAction === 'string' ? parsed.nextAction : 'Verify independently before trading.',
    }

    return { verdict, clarkError: null }
  } catch (err) {
    console.error('[dev-wallet] Clark error:', err)
    return { verdict: null, clarkError: 'Clark analysis failed — verify manually.' }
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────

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

    // Verify contract exists on Base
    let bytecode: string
    try {
      bytecode = await alchemyRpc('eth_getCode', [contractAddress, 'latest']) as string
    } catch {
      return NextResponse.json({ error: 'Could not reach Base RPC — try again' }, { status: 502 })
    }

    if (!bytecode || bytecode === '0x') {
      return NextResponse.json(
        { error: 'No contract found at this address on Base mainnet' },
        { status: 400 }
      )
    }

    // Step 1 — Deployer
    const { address: deployerAddress, confidence: deployerConfidence, methodUsed } =
      await findDeployer(contractAddress)

    if (!deployerAddress) {
      warnings.push('Deployer could not be identified — no historical transactions found yet')
    } else if (deployerConfidence === 'medium') {
      warnings.push('Deployer identified via earliest-transaction heuristic — not cryptographically confirmed')
    }

    // Step 2 — Linked wallets
    let linkedWallets: LinkedWallet[] = []
    if (deployerAddress) {
      linkedWallets = await findLinkedWallets(deployerAddress, contractAddress)
    } else {
      warnings.push('Linked wallets unavailable — deployer address unknown')
    }

    // Step 3 — Supply
    const { holderDataAvailable, supplyControlled, matchedHolderWallets } =
      await getSupplyData(contractAddress, deployerAddress, linkedWallets)
    if (!holderDataAvailable) {
      warnings.push('Holder distribution data unavailable from Covalent')
    }

    // Step 4 — Previous projects
    const { previousDeploymentsAvailable, previousProjects } = getPreviousProjectsResult()
    warnings.push('Previous deployment history unavailable — block explorer API key not configured')

    // Step 5 — Suspicious transfers
    const { suspiciousTransfers, suspiciousTransferReasons } =
      detectSuspiciousTransfers(linkedWallets, supplyControlled)

    // Step 6 — Clark
    const { verdict: clarkVerdict, clarkError } = await getClarkVerdict({
      contractAddress,
      deployerAddress,
      deployerConfidence,
      linkedWallets,
      supplyControlled,
      holderDataAvailable,
      previousProjects,
      suspiciousTransfers,
      suspiciousTransferReasons,
    })
    if (clarkError) warnings.push(`Clark: ${clarkError}`)

    return NextResponse.json({
      contractAddress,
      chain: 'base',
      deployerAddress,
      deployerConfidence,
      methodUsed,
      linkedWallets,
      holderDataAvailable,
      supplyControlled,
      matchedHolderWallets,
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
