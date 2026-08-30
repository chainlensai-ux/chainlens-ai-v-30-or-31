'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import ClarkOrb from '@/components/ClarkOrb'
import { supabase } from '@/lib/supabaseClient'
import { getClarkSessionId as getOrCreateSessionId, readClarkClientContext as getClientClarkContext, persistClarkMemoryEcho, persistClarkMomentumList, resolveClarkCommandChipTarget } from '@/lib/client/clarkMemory'

const HINT_CHIPS = [
  'Scan BRETT',
  "What's pumping on Base?",
  'Analyze this wallet',
  'Liquidity check AERO',
]

interface MoverItem {
  rank?: number
  symbol: string
  name?: string | null
  tokenAddress?: string | null
  poolAddress?: string | null
  reasonTag?: string | null
  price?: number | null
  liquidity?: number | null
  volume24h?: number | null
  change24h?: number | null
}

interface Message {
  role: 'user' | 'clark'
  text: string
  // STRUCTURED MOVERS, DISCLOSED (Clark panel redesign — presentational only): the SAME real
  // marketContext.items array the backend already returns and this component already persisted
  // into clarkContextRef for follow-up-prompt memory — never fabricated, never re-fetched. Attached
  // to the specific message that produced it so mover rows render against the right response.
  movers?: MoverItem[]
}

type AnalysisKind = 'token' | 'wallet' | 'lp' | 'general'
const ANALYSIS_STAGES: Record<AnalysisKind, string[]> = {
  token: ['Analyzing token...', 'Checking liquidity...', 'Reviewing holder distribution...', 'Inspecting security signals...', 'Building CORTEX summary...'],
  wallet: ['Loading portfolio...', 'Reviewing activity...', 'Checking chain exposure...', 'Building wallet profile...', 'Preparing intelligence report...'],
  lp: ['Reviewing liquidity...', 'Checking LP control...', 'Analyzing concentrated positions...', 'Preparing LP report...'],
  general: ['Parsing request...', 'Loading CORTEX context...', 'Reviewing Base signals...', 'Preparing intelligence report...'],
}
function inferAnalysisKind(text: string): AnalysisKind {
  const t = text.toLowerCase()
  if (/\b(wallet|portfolio|holdings?|pnl|whale)\b/.test(t)) return 'wallet'
  if (/\b(lp|liquidity|pool|lock|unlock|concentrated)\b/.test(t)) return 'lp'
  if (/\b(token|contract|ca\b|holders?|deployer|rug|safe|scan)\b/.test(t)) return 'token'
  return 'general'
}
const CLARK_TRACE_STEPS = ['Context', 'Signals', 'Response']

function ClarkLoadingTrace({ kind }: { kind: AnalysisKind }) {
  const stages = ANALYSIS_STAGES[kind]
  const [stage, setStage] = useState(0)
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    setStage(0)
    const id = window.setInterval(() => setStage((current) => Math.min(current + 1, stages.length - 1)), 1200)
    return () => window.clearInterval(id)
  }, [kind, stages.length])
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReducedMotion(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const progress = stage / Math.max(1, stages.length - 1)
  const activeStep = progress < 0.34 ? 0 : progress < 0.75 ? 1 : 2
  return (
    <div className="clark-loading-trace">
      <div className="clark-loading-head">
        <ThinkingOrb state="composing" size={20} speed={2.2} paused={reducedMotion} />
        <span className="clark-loading-title">CORTEX processing…</span>
      </div>
      <div className="clark-loading-stage">{stages[stage] ?? stages[0]}</div>
      <div className="clark-loading-steps">
        {CLARK_TRACE_STEPS.map((step, i) => (
          <span key={step} className={`clark-loading-step${i <= activeStep ? ' is-active' : ''}`}>
            {step}
            {i < CLARK_TRACE_STEPS.length - 1 && <span className="clark-loading-step-sep">·</span>}
          </span>
        ))}
      </div>
      <div className="clark-loading-shimmer" />
    </div>
  )
}

type ClarkMode = 'chat' | 'analyst'
type ClarkContextState = {
  lastMarketList?: Array<{
    rank: number
    symbol: string
    name?: string | null
    tokenAddress?: string | null
    poolAddress?: string | null
    reasonTag?: string | null
    price?: number | null
    liquidity?: number | null
    volume24h?: number | null
    change24h?: number | null
  }>
  lastIntent?: string | null
  previousIntent?: string | null
  lastSelectedRank?: number | null
  marketCursor?: {
    offset: number
    returnedCount: number
    requestedCount: number
    totalCandidates: number
  } | null
  seenMarketAddresses?: string[]
  seenMarketSymbols?: string[]
}

// Try to pull a token name from a message like "is brett safe?" or "toshi price"
function extractTokenQuery(text: string): string | null {
  const t = text.toLowerCase()
  const STOP = new Set(['a', 'an', 'the', 'this', 'that', 'it', 'is', 'are', 'be', 'me', 'my',
    'on', 'in', 'of', 'to', 'and', 'or', 'so', 'do', 'for', 'going', 'doing', 'there', 'here'])

  const cmd = t.match(/\b(?:scan|check|analyze|info\s+on|about)\s+([a-z][a-z0-9]{1,15})\b/)
  if (cmd && !STOP.has(cmd[1])) return cmd[1]

  const before = t.match(/\b([a-z][a-z0-9]{1,15})\s+(?:price|liquidity|volume|safe|safety|pools?|rug|chart|cap|analysis|pumping)\b/)
  if (before && !STOP.has(before[1])) return before[1]

  const afterIs = t.match(/\bis\s+([a-z][a-z0-9]{1,15})\b/)
  if (afterIs && !STOP.has(afterIs[1])) return afterIs[1]

  return null
}

function isMobileClient() {
  return typeof window !== 'undefined' && (window.innerWidth < 768 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent))
}

// BARE SLASH-COMMAND HANDLING, DISCLOSED (Clark panel empty/default message polish task): purely
// client-side — there is no slash-command parser on the backend, so "/wallet" typed alone was
// previously just forwarded as literal text and fell through to whatever the general prompt path
// made of it. A bare command (no address/target after it) now short-circuits BEFORE any network
// call and shows a canned prompt-for-input reply locally — same intent as the task's required
// copy, zero new API surface. "/base" is the one command that's already actionable on its own
// (a market read needs no target), so it's rewritten to the same natural-language prompt the
// existing "What's pumping on Base?" hint chip already sends — still one normal sendToClark() call.
function bareSlashCommandReply(text: string): string | null {
  const t = text.trim().toLowerCase()
  if (/^\/wallet$/.test(t)) return "Paste a wallet address and I'll analyze it."
  if (/^\/token$/.test(t)) return "Paste a token contract and I'll scan it."
  if (/^\/lp$/.test(t)) return "Paste a token or pool and I'll check LP control and lock status."
  return null
}

function expandSlashCommand(text: string): string {
  const t = text.trim()
  if (/^\/base$/i.test(t)) return "What's pumping on Base?"
  return text
}

const WALLET_INTENT = /\b(wallet|balance|balances|holdings?|portfolio|hold\b|holds\b|copy[\s-]?trade?|copytrade|follow|smart\s+money|good\s+wallet|whale\s+wallet|wallet\s+quality)\b/i
const MARKET_INTENT = /\b(pumping|pump(?:ing)?|hot\b|moving\b|movers?|gainers?|runners?|new\s+launches?|new\s+tokens?|what\s+should\s+i\s+watch|what'?s\s+on\s+base)\b/i

function parseMessage(raw: string, clarkMode: ClarkMode): Record<string, string> {
  const t = raw.trim().toLowerCase()
  if (t.startsWith('clark ai:')) return { feature: 'clark-ai', prompt: raw.trim().slice(9).trim() }
  return { feature: 'clark-ai', prompt: raw.trim() }
}

function formatResponse(data: Record<string, unknown>): string {
  if (typeof data?.analysis === 'string') return data.analysis
  return JSON.stringify(data, null, 2)
}

interface ClarkRadarProps {
  onSelectRadar?: (val: string) => void
  pendingMessage?: string | null
}

// ── Structured analysis rendering, DISCLOSED (Clark panel redesign — presentational only) ────
// Everything below reformats the SAME reply text/marketContext.items the backend already returns.
// No text is invented, summarized, or reworded — only re-laid-out: label lines become section
// headers, "0x..." substrings become copy chips, and (when the backend attached real
// marketContext.items to this response) plain "- Token: ..." list lines are additionally rendered
// as structured rows using that real data instead of just as text.

type ClarkSection = { title: string | null; lines: string[] }

const SECTION_LABEL_RE = /^([A-Z][^\n:]{0,32}):\s*(.*)$/
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g

function isSectionLabel(candidate: string): boolean {
  const words = candidate.trim().split(/\s+/)
  return words.length > 0 && words.length <= 5 && !/[,;.!?]/.test(candidate)
}

// Splits a reply into labeled sections (e.g. "Clark's read:", "Best next step:") the same way the
// backend already formats multi-part answers — never re-parses meaning, only groups existing lines
// under their existing headers so each part can render as its own card block.
function splitIntoSections(text: string): ClarkSection[] {
  const rawLines = text.split('\n')
  const sections: ClarkSection[] = []
  let current: ClarkSection = { title: null, lines: [] }
  for (const raw of rawLines) {
    const m = raw.match(SECTION_LABEL_RE)
    if (m && isSectionLabel(m[1])) {
      if (current.title !== null || current.lines.some((l) => l.trim())) sections.push(current)
      current = { title: m[1].trim(), lines: m[2] ? [m[2]] : [] }
    } else {
      current.lines.push(raw)
    }
  }
  sections.push(current)
  return sections.filter((s) => s.title || s.lines.some((l) => l.trim()))
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function CopyContractChip({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="clark-addr-chip"
      title={address}
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {shortAddr(address)}
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        {copied
          ? <path d="M5 13l4 4L19 7" stroke="#5eead4" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          : <path d="M9 9h10v10H9zM5 5h10v4H9v6H5z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
    </button>
  )
}

// Renders one line of reply text, compressing any raw "0x..." contract address into a truncated,
// monospace copy chip instead of dumping the full 42-character string inline.
function TextLineWithAddresses({ line }: { line: string }) {
  const parts = line.split(ADDRESS_RE)
  const matches = line.match(ADDRESS_RE)
  if (!matches) return <>{line}</>
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < matches.length && <CopyContractChip address={matches[i]} />}
        </span>
      ))}
    </>
  )
}

function fmtUsdShort(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(n < 1 ? 4 : 2)}`
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

// Maps the backend's own reason-tag words (never invented here — see classifyBaseMarketReason()
// in app/api/clark/route.ts for "liquid mover"/"volume expansion"/"new pool"/"established Base")
// to a visual tone: teal for the confirmed/liquid case, amber for the higher-risk "new pool" case,
// purple as the neutral accent for everything else.
function moverTagTone(tag: string): 'positive' | 'caution' | 'accent' {
  const t = tag.toLowerCase()
  if (t.includes('liquid') || t.includes('established')) return 'positive'
  if (t.includes('new pool') || t.includes('thin')) return 'caution'
  return 'accent'
}

// Compact mover row — the structured alternative to a plain "- Token: 24h +x%, vol $y, liq $z"
// text line, using the SAME real per-item fields the backend's marketContext.items already carries.
function MoverRow({ item, onScan, onWatch, watchState }: {
  item: MoverItem
  onScan: (item: MoverItem) => void
  onWatch: (item: MoverItem) => void
  watchState: 'idle' | 'saving' | 'saved' | 'error'
}) {
  const positive = (item.change24h ?? 0) >= 0
  const contract = item.tokenAddress ?? item.poolAddress ?? null
  // TWO-LINE LAYOUT, DISCLOSED (Clark right-panel layout fix task): the right panel is narrow, so
  // packing rank/symbol/tag/%/vol/liq/contract/actions into one row squeezed everything together.
  // Split into a top identity row (rank, symbol, tag, 24h%) and a bottom metrics+actions row (vol,
  // liq, contract chip, Scan/Watch) — same fields, same real data, just given room to breathe.
  return (
    <div className="clark-mover-row">
      <div className="clark-mover-row-top">
        {item.rank != null && <span className="clark-mover-rank">#{item.rank}</span>}
        <span className="clark-mover-symbol">{item.symbol}</span>
        {item.reasonTag && (
          <span className={`clark-mover-tag clark-mover-tag--${moverTagTone(item.reasonTag)}`}>{item.reasonTag}</span>
        )}
        <span className={`clark-mover-change${positive ? ' is-up' : ' is-down'}`}>{fmtPct(item.change24h)}</span>
      </div>
      <div className="clark-mover-row-bottom">
        <div className="clark-mover-row-stats">
          <span>Vol {fmtUsdShort(item.volume24h)}</span>
          <span className="clark-mover-dot">·</span>
          <span>Liq {fmtUsdShort(item.liquidity)}</span>
          {contract && (
            <>
              <span className="clark-mover-dot">·</span>
              <CopyContractChip address={contract} />
            </>
          )}
        </div>
        <div className="clark-mover-row-actions">
          <button type="button" className="clark-mover-action" onClick={() => onScan(item)}>Scan</button>
          <button
            type="button"
            className={`clark-mover-action${watchState === 'saved' ? ' is-active' : ''}`}
            onClick={() => onWatch(item)}
            disabled={watchState === 'saving'}
          >
            {watchState === 'saved' ? 'Watching' : watchState === 'saving' ? '…' : 'Watch'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Base Market Read structured card, DISCLOSED (Clark market-read rendering task) ────────────
// Parses the EXACT, deterministic text shape formatBaseMarketReply() (app/api/clark/route.ts)
// always produces — never re-interprets meaning, only lifts the same numbers/words already in the
// message into a structured card. Every field rendered below (rank, symbol, % change, vol, liq,
// tag, contract, candidate count, short-read lines, next-step lines) is copied verbatim from a
// regex match against the real reply text; nothing is computed, guessed, or fabricated. If the
// text doesn't match this exact shape (any other Clark reply, or a future backend wording change),
// parsing yields null and the caller falls back to the existing generic section renderer untouched.
type ParsedMarketRead = {
  extended: boolean
  candidateCount: number | null
  movers: MoverItem[]
  shortRead: string[]
  next: string[]
}

const MARKET_READ_HEADER_RE = /^BASE MARKET READ(?:\s*—\s*extended list)?:?\s*$/im
const MARKET_READ_COUNT_RE = /Clark is seeing\s+(\d+)\s+usable Base candidates/i
const MARKET_READ_MOVER_RE = /^(\d+)\.\s+(\S+)\s+—\s+(-?[\d.]+%|n\/a)\s*24h,\s*vol\s+([^,]+),\s*liq\s+([^\s—]+)\s+—\s+(.+?)\s*\r?\n\s*Contract:\s*(\S+)\s*$/gim

function parseBaseMarketRead(text: string): ParsedMarketRead | null {
  if (!MARKET_READ_HEADER_RE.test(text)) return null

  const movingIdx = text.search(/^Moving now:\s*$/im)
  const shortReadIdx = text.search(/^Short read:\s*$/im)
  const nextIdx = text.search(/^Next:\s*$/im)
  if (movingIdx === -1) return null

  const moversBlockEnd = shortReadIdx !== -1 ? shortReadIdx : (nextIdx !== -1 ? nextIdx : text.length)
  const moversBlock = text.slice(movingIdx, moversBlockEnd)

  const movers: MoverItem[] = []
  for (const m of moversBlock.matchAll(MARKET_READ_MOVER_RE)) {
    const [, rankStr, symbol, changeStr, vol, liq, tag, addr] = m
    movers.push({
      rank: Number(rankStr) || undefined,
      symbol,
      reasonTag: tag.trim() || null,
      change24h: changeStr === 'n/a' ? null : parseFloat(changeStr),
      volume24h: parseUsdShort(vol),
      liquidity: parseUsdShort(liq),
      tokenAddress: addr.toLowerCase() === 'unresolved' ? null : addr,
    })
  }
  if (movers.length === 0) return null

  const shortRead = shortReadIdx !== -1
    ? text.slice(shortReadIdx, nextIdx !== -1 ? nextIdx : text.length)
      .replace(/^Short read:\s*/im, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    : []

  const next = nextIdx !== -1
    ? text.slice(nextIdx)
      .replace(/^Next:\s*/im, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    : []

  const countMatch = text.match(MARKET_READ_COUNT_RE)
  return {
    extended: /extended list/i.test(text),
    candidateCount: countMatch ? Number(countMatch[1]) : null,
    movers,
    shortRead,
    next,
  }
}

// Reverses fmtUsdShort's own "$24.0M" / "$9.7K" / "$1.23" formatting back to a number — the same
// short-form the backend's formatUsdShort() already produced this text with, just parsed back out.
function parseUsdShort(raw: string): number | null {
  const m = raw.trim().match(/^\$?([\d.]+)([KM])?$/i)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  if (m[2]?.toUpperCase() === 'M') return n * 1_000_000
  if (m[2]?.toUpperCase() === 'K') return n * 1_000
  return n
}

function MarketReadCard({ data, onScan, onWatch, watchStateFor, onReplyPrompt }: {
  data: ParsedMarketRead
  onScan: (item: MoverItem) => void
  onWatch: (item: MoverItem) => void
  watchStateFor: (item: MoverItem) => 'idle' | 'saving' | 'saved' | 'error'
  onReplyPrompt: () => void
}) {
  return (
    <div className="clark-market-card">
      <div className="clark-market-head">
        <div>
          <div className="clark-market-title">
            BASE MARKET READ
            {data.extended && <span className="clark-market-title-suffix"> · extended</span>}
          </div>
          {data.candidateCount != null && (
            <div className="clark-market-subtitle">{data.candidateCount} usable Base candidates</div>
          )}
        </div>
        <span className="clark-market-live-badge">LIVE BASE</span>
      </div>

      <div className="clark-section">
        <div className="clark-section-title">Moving Now</div>
        <div className="clark-mover-list">
          {data.movers.map((item, i) => (
            <MoverRow
              key={`${item.symbol}-${item.rank ?? i}`}
              item={item}
              onScan={onScan}
              onWatch={onWatch}
              watchState={watchStateFor(item)}
            />
          ))}
        </div>
      </div>

      {data.shortRead.length > 0 && (
        <div className="clark-market-shortread">
          <div className="clark-section-title">Short Read</div>
          {data.shortRead.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      )}

      {data.next.length > 0 && (
        <div className="clark-market-next">
          <div className="clark-section-title">Next</div>
          {data.next.map((line, i) => <p key={i}>{line}</p>)}
          <button type="button" className="clark-market-next-cta" onClick={onReplyPrompt}>
            Reply with rank or symbol
          </button>
        </div>
      )}
    </div>
  )
}

// Renders one reply as structured analysis: section headers for label lines, mover-row cards for
// list lines when this message carries real marketContext.items, plain lines otherwise — same
// content, never rewritten, just given hierarchy instead of one flat text block.
function ClarkMessage({ text, movers, onScan, onWatch, watchStateFor, onReplyPrompt }: {
  text: string
  movers?: MoverItem[]
  onScan: (item: MoverItem) => void
  onWatch: (item: MoverItem) => void
  watchStateFor: (item: MoverItem) => 'idle' | 'saving' | 'saved' | 'error'
  onReplyPrompt: () => void
}) {
  // Base Market Read gets its own dedicated card when the text matches that exact shape; any other
  // reply (or a match attempt that comes back empty) falls straight through to the generic,
  // already-existing section/bullet/mover renderer below — unchanged for every other message type.
  const marketRead = parseBaseMarketRead(text)
  if (marketRead) {
    return (
      <MarketReadCard
        data={marketRead}
        onScan={onScan}
        onWatch={onWatch}
        watchStateFor={watchStateFor}
        onReplyPrompt={onReplyPrompt}
      />
    )
  }

  const sections = splitIntoSections(text)
  // A section's own list lines start with "- " (the backend's own bullet convention for
  // mover-style lists). Only the FIRST such section on a message that carries real movers renders
  // structured rows instead of the raw bullet text; every other section renders as-is. Computed
  // once up front (not mutated during the render below) so the section list stays pure per render.
  const firstListSectionIndex = movers && movers.length > 0
    ? sections.findIndex((section) => section.lines.some((l) => l.trim().startsWith('- ')))
    : -1
  return (
    <div className="clark-analysis" style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}>
      {sections.map((section, si) => {
        const useStructuredMovers = si === firstListSectionIndex
        return (
          <div key={si} className="clark-section">
            {section.title && <div className="clark-section-title">{section.title}</div>}
            {useStructuredMovers ? (
              <div className="clark-mover-list">
                {(movers ?? []).slice(0, 8).map((item, mi) => (
                  <MoverRow
                    key={`${item.symbol}-${mi}`}
                    item={item}
                    onScan={onScan}
                    onWatch={onWatch}
                    watchState={watchStateFor(item)}
                  />
                ))}
              </div>
            ) : (
              section.lines.map((line, li) => {
                if (!line.trim()) return <div key={li} style={{ height: '6px' }} />
                const isBullet = line.trim().startsWith('- ')
                return (
                  <div key={li} className={isBullet ? 'clark-section-bullet' : 'clark-section-line'}>
                    <TextLineWithAddresses line={isBullet ? line.trim().slice(2) : line} />
                  </div>
                )
              })
            )}
            {si < sections.length - 1 && <div className="clark-section-divider" />}
          </div>
        )
      })}
    </div>
  )
}

export default function ClarkRadar({ onSelectRadar: _onSelectRadar, pendingMessage }: ClarkRadarProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingKind, setLoadingKind] = useState<AnalysisKind>('general')
  const [clarkMode, setClarkMode] = useState<ClarkMode>('chat')
  const [watchStates, setWatchStates] = useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<Message[]>([])
  const lastSentRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const clarkContextRef = useRef<ClarkContextState>({})

  useEffect(() => {
    messagesRef.current = messages
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const sendToClark = useCallback(async (text: string) => {
    setMessages(prev => [...prev, { role: 'user', text }])
    setLoadingKind(inferAnalysisKind(text))
    setLoading(true)
    setMessages(prev => [...prev, { role: 'clark', text: 'Clark is thinking...' }])

    try {
      const body = parseMessage(text, clarkMode)
      const requestMode = clarkMode
      const history = [...messagesRef.current, { role: 'user', text }]
        .slice(-10)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
      if (process.env.NODE_ENV === 'development') {
        console.log('[clark] request context', {
          moversCount: clarkContextRef.current.lastMarketList?.length ?? 0,
          lastSelectedRank: clarkContextRef.current.lastSelectedRank ?? null,
        })
      }
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      // ALWAYS-SAME-DEPLOYER FIX, DISCLOSED (live report: "for every fcking token i say check
      // deployer its this same blue bull"). This widget never sent appContext.tokenSummary at all —
      // the full /terminal/clark-ai page already reads Token Scanner's last-scan summary out of
      // localStorage and forwards it so Clark knows about a token scanned directly through Token
      // Scanner's own UI (no Clark chat turn involved). Without it, a "check deployer"/"who deployed
      // this" question here could only ever resolve against whichever token CLARK itself last
      // scanned — a stale, possibly much older token, exactly as reported.
      let tokenSummary: Record<string, unknown> | null = null
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('chainlens:clark:lastTokenSummary') : null
        tokenSummary = raw ? JSON.parse(raw) as Record<string, unknown> : null
      } catch { tokenSummary = null }
      const res = await fetch(`/api/clark`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'x-clark-session': getOrCreateSessionId(),
        },
        body: JSON.stringify({
          ...body,
          message: text,
          mode: requestMode,
          uiModeHint: clarkMode,
          context: null,
          history,
          sessionId: getOrCreateSessionId(),
          clarkContext: clarkContextRef.current,
          recentMovers: clarkContextRef.current.lastMarketList ?? [],
          moversContext: { items: clarkContextRef.current.lastMarketList ?? [] },
          marketContext: { items: clarkContextRef.current.lastMarketList ?? [] },
          clientContext: getClientClarkContext(),
          ...(tokenSummary ? { appContext: { tokenSummary, currentTokenAddress: (tokenSummary.address as string | undefined) ?? null } } : {}),
        }),
      })
      const json = await res.json()
      const payload = (json.data as Record<string, unknown>) ?? {}
      const marketContext = (payload.marketContext && typeof payload.marketContext === 'object')
        ? payload.marketContext as { items?: unknown }
        : null
      const nextItems = Array.isArray(marketContext?.items) ? marketContext?.items : null
      if (nextItems && nextItems.length > 0) {
        persistClarkMomentumList(nextItems)
        clarkContextRef.current.lastMarketList = nextItems as ClarkContextState['lastMarketList']
        const addrSet = new Set((clarkContextRef.current.seenMarketAddresses ?? []).map((x) => x.toLowerCase()))
        const symSet = new Set((clarkContextRef.current.seenMarketSymbols ?? []).map((x) => x.toUpperCase()))
        for (const item of nextItems as Array<Record<string, unknown>>) {
          const token = typeof item.tokenAddress === 'string' ? item.tokenAddress.toLowerCase() : null
          const pool = typeof item.poolAddress === 'string' ? item.poolAddress.toLowerCase() : null
          const sym = typeof item.symbol === 'string' ? item.symbol.toUpperCase() : null
          if (token) addrSet.add(token)
          if (pool) addrSet.add(pool)
          if (sym) symSet.add(sym)
        }
        clarkContextRef.current.seenMarketAddresses = [...addrSet].slice(-200)
        clarkContextRef.current.seenMarketSymbols = [...symSet].slice(-200)
      }
      const cursor = (marketContext && typeof marketContext === 'object' && (marketContext as Record<string, unknown>).cursor && typeof (marketContext as Record<string, unknown>).cursor === 'object')
        ? (marketContext as Record<string, unknown>).cursor as ClarkContextState['marketCursor']
        : null
      if (cursor) clarkContextRef.current.marketCursor = cursor
      // Cross-surface sync: persist this response's wallet/token memory through the same shared
      // helper every Clark surface uses, so a scan made here is immediately visible elsewhere.
      persistClarkMemoryEcho(payload)
      clarkContextRef.current.previousIntent = clarkContextRef.current.lastIntent ?? null
      clarkContextRef.current.lastIntent = typeof payload.intent === 'string' ? payload.intent : clarkContextRef.current.lastIntent
      clarkContextRef.current.lastSelectedRank = /\b([1-9]\d{0,2})\b/.test(text) ? Number(text.match(/\b([1-9]\d{0,2})\b/)?.[1] ?? 0) || null : clarkContextRef.current.lastSelectedRank
      const reply = json.ok
        ? String(payload?.reply ?? formatResponse(payload))
        : (json.error ?? 'Something went wrong.')
      // ATTACH REAL MOVERS, DISCLOSED: nextItems is the same already-extracted, already-persisted
      // marketContext.items this function computed above — attached here only for display, never
      // altering the reply text or any of the existing memory/context wiring above.
      const movers = json.ok && nextItems && nextItems.length > 0 ? (nextItems as MoverItem[]) : undefined

      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: reply, movers }
        return next
      })
    } catch {
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: 'Clark backend unreachable.' }
        return next
      })
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }, [clarkMode])

  // MICRO-ACTIONS, DISCLOSED (Clark panel redesign): "Scan" reuses sendToClark exactly like typing
  // a prompt would — no new backend path. "Watch" reuses the existing, unmodified
  // /api/watchlist/tokens endpoint the Watchlist page already calls; this is the same real
  // add-to-watchlist action, just triggered from a mover row instead of that page.
  const watchKey = useCallback((item: MoverItem) => (item.tokenAddress ?? item.poolAddress ?? item.symbol).toLowerCase(), [])
  const watchStateFor = useCallback((item: MoverItem) => watchStates[watchKey(item)] ?? 'idle', [watchStates, watchKey])

  const handleScanMover = useCallback((item: MoverItem) => {
    const target = item.tokenAddress ?? item.symbol
    sendToClark(`Scan ${target}`)
  }, [sendToClark])

  const handleWatchMover = useCallback(async (item: MoverItem) => {
    const key = watchKey(item)
    if (watchStates[key] === 'saving' || watchStates[key] === 'saved') return
    setWatchStates(prev => ({ ...prev, [key]: 'saving' }))
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) { setWatchStates(prev => ({ ...prev, [key]: 'error' })); return }
      const address = item.tokenAddress ?? item.poolAddress ?? ''
      if (!address) { setWatchStates(prev => ({ ...prev, [key]: 'error' })); return }
      const res = await fetch('/api/watchlist/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ address, symbol: item.symbol, chain: 'base' }),
      })
      setWatchStates(prev => ({ ...prev, [key]: res.ok ? 'saved' : 'error' }))
    } catch {
      setWatchStates(prev => ({ ...prev, [key]: 'error' }))
    }
  }, [watchStates, watchKey])

  useEffect(() => {
    if (pendingMessage && pendingMessage !== lastSentRef.current) {
      lastSentRef.current = pendingMessage
      setClarkMode('analyst')
      sendToClark(pendingMessage)
    }
  }, [pendingMessage, sendToClark])

  function handleSend() {
    const text = input.trim()
    if (!text || loading) return
    if (isMobileClient()) {
      window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(text)}&autosend=1`
      return
    }
    const slashBare = text.match(/^\/(lp|token|wallet)$/i)
    if (slashBare) {
      const cmd = slashBare[1].toLowerCase() as 'lp' | 'token' | 'wallet'
      const target = resolveClarkCommandChipTarget(cmd, getClientClarkContext())
      if (target) {
        setInput('')
        sendToClark(`/${cmd} ${target}`)
        return
      }
    }
    const bareReply = bareSlashCommandReply(text)
    if (bareReply) {
      setInput('')
      setMessages(prev => [...prev, { role: 'user', text }, { role: 'clark', text: bareReply }])
      return
    }
    setInput('')
    sendToClark(expandSlashCommand(text))
  }

  function applyQuickChip(prefix: string) {
    if (prefix === '/lp' || prefix === '/token' || prefix === '/wallet') {
      const target = resolveClarkCommandChipTarget(prefix.slice(1) as 'lp' | 'token' | 'wallet', getClientClarkContext())
      if (target) {
        setInput('')
        sendToClark(`${prefix} ${target}`)
        return
      }
    }
    setInput(`${prefix} `)
    inputRef.current?.focus()
  }

  return (
    <>
      <style>{`
        /* PREMIUM-RESTRAINT PASS, DISCLOSED (Clark panel redesign): the panel previously breathed a
           continuously-animated inset box-shadow across its whole surface (clarkPanelGlow) and the
           send button pulsed a candy-glow even at rest (radarSendGlow/radarArrowPulse) — exactly the
           "flashy/glowy... feels cheap" pattern this task asks to remove. Both are now static; only
           opacity/transform animate anywhere below (plus the pre-existing, deliberately-kept loading
           shimmer/online dot, which already used background-position/opacity only).
           */
        .clark-online-dot {
          box-shadow: 0 0 4px rgba(139,92,246,0.55);
        }
        @keyframes clarkOnlinePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
        .clark-online-dot { animation: clarkOnlinePulse 3s ease-in-out infinite; }

        .clark-hint-chip {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          padding: 7px 10px;
          color: rgba(255,255,255,0.40);
          font-size: 11px;
          font-family: var(--font-inter);
          cursor: pointer;
          text-align: left;
          display: flex;
          align-items: center;
          gap: 7px;
          width: 100%;
          transition: border-color 0.15s, color 0.15s, background 0.15s;
        }
        .clark-hint-chip:hover {
          border-color: rgba(139,92,246,0.30);
          color: rgba(255,255,255,0.80);
          background: rgba(139,92,246,0.06);
        }
        .clark-panel-input::placeholder { color: rgba(255,255,255,0.36); }
        .clark-mode-toggle {
          display: inline-flex;
          gap: 5px;
          padding: 3px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(10,12,26,0.74);
        }
        .clark-mode-btn {
          border: none;
          border-radius: 999px;
          padding: 5px 9px;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.55);
          background: transparent;
          cursor: pointer;
          transition: color 0.15s, background 0.15s;
          white-space: nowrap;
        }
        .clark-mode-btn.active {
          color: #e2e8f0;
          background: linear-gradient(90deg, rgba(45,212,191,0.20), rgba(139,92,246,0.20));
        }
        .clark-radar-send { transition: transform 0.15s, background 0.15s; }
        .clark-radar-send:hover { transform: translateY(-1px); }
        .clark-radar-scroll::-webkit-scrollbar { width: 3px; }
        .clark-radar-scroll::-webkit-scrollbar-thumb {
          background: rgba(123,92,255,0.30);
          border-radius: 3px;
        }
        .clark-loading-trace { min-width: 210px; display: flex; flex-direction: column; gap: 6px; }
        .clark-loading-head { display: flex; align-items: center; gap: 7px; }
        .clark-loading-title {
          color: #5eead4; font: 800 10px var(--font-plex-mono); letter-spacing: .08em;
          text-transform: uppercase;
        }
        .clark-loading-stage { color: rgba(219,234,254,0.78); font: 600 11px var(--font-plex-mono); letter-spacing: .02em; }
        .clark-loading-steps { display: flex; align-items: center; gap: 3px; font: 700 8.5px var(--font-plex-mono); letter-spacing: .06em; text-transform: uppercase; }
        .clark-loading-step { color: rgba(148,163,184,0.42); transition: color 0.3s; display: inline-flex; align-items: center; gap: 3px; }
        .clark-loading-step.is-active { color: rgba(94,234,212,0.85); }
        .clark-loading-step-sep { color: rgba(148,163,184,0.30); margin-left: 3px; }
        .clark-loading-shimmer {
          height: 2px; border-radius: 2px; margin-top: 2px; overflow: hidden;
          background: linear-gradient(90deg, rgba(45,212,191,0) 0%, rgba(45,212,191,0.55) 50%, rgba(45,212,191,0) 100%);
          background-size: 200% 100%;
          animation: clarkTraceShimmer 1.7s linear infinite;
        }
        @keyframes clarkTraceShimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
        .clark-orb { position: relative; border-radius: 999px; }
        .clark-orb::before {
          content: ''; position: absolute; inset: -5px; border-radius: inherit;
          background: radial-gradient(circle, rgba(45,212,191,0.16) 0%, rgba(139,92,246,0.06) 52%, transparent 72%);
          opacity: 0; pointer-events: none;
        }
        @keyframes clarkRadarPulse { 0%,100% { opacity: 0.28; } 50% { opacity: 0.55; } }
        .clark-orb-thinking::before { animation: clarkRadarPulse 1.8s ease-in-out infinite; opacity: 1; }

        /* Message shell — bubbles restyled as calmer, structured cards rather than flat chat pills. */
        .clark-bubble-user {
          background: linear-gradient(135deg, rgba(45,212,191,0.09) 0%, rgba(45,212,191,0.03) 100%);
          border: 1px solid rgba(45,212,191,0.20);
        }
        .clark-bubble-clark {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .clark-bubble-role-user { color: #5eead4; }
        .clark-bubble-role-clark { color: rgba(196,181,253,0.85); }

        /* Structured analysis sections */
        .clark-section { display: flex; flex-direction: column; }
        .clark-section-title {
          font: 800 9.5px var(--font-plex-mono); letter-spacing: .10em; text-transform: uppercase;
          color: #5eead4; margin-bottom: 4px;
        }
        .clark-section-line { line-height: 1.75; color: inherit; }
        .clark-section-bullet {
          line-height: 1.75; color: inherit; padding-left: 12px; position: relative;
        }
        .clark-section-bullet::before {
          content: '–'; position: absolute; left: 0; color: rgba(94,234,212,0.55);
        }
        .clark-section-divider {
          height: 1px; margin: 9px 0; background: rgba(255,255,255,0.06);
        }

        /* Contract address compression */
        .clark-addr-chip {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 6px; border-radius: 5px;
          background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.18);
          color: rgba(196,181,253,0.85); font-family: var(--font-plex-mono); font-size: 10.5px;
          cursor: pointer; transition: background 0.15s, border-color 0.15s;
          vertical-align: middle; flex-shrink: 0;
        }
        .clark-addr-chip:hover { background: rgba(139,92,246,0.14); border-color: rgba(139,92,246,0.30); }

        /* Mover rows — a little more breathing room, calmer tags, quieter actions (micro-polish
           pass: same structure/data as before, just less cramped and less button-heavy). */
        .clark-mover-list {
          display: flex; flex-direction: column; gap: 6px;
          max-width: 100%; overflow-x: hidden;
        }
        .clark-mover-row {
          display: flex; flex-direction: column; gap: 6px;
          padding: 9px 11px; border-radius: 9px; min-width: 0; max-width: 100%;
          background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.055);
        }
        .clark-mover-row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .clark-mover-row-bottom {
          display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0;
        }
        .clark-mover-rank { font: 700 9.5px var(--font-plex-mono); color: rgba(148,163,184,0.50); flex-shrink: 0; }
        .clark-mover-symbol {
          font: 800 11.5px var(--font-plex-mono); color: #f1f5f9; letter-spacing: .01em;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px;
        }
        .clark-mover-tag {
          font: 700 8px var(--font-inter); letter-spacing: .03em; text-transform: uppercase;
          border-radius: 4px; padding: 1.5px 5px; flex-shrink: 1; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .clark-mover-tag--positive { color: rgba(94,234,212,0.85); background: rgba(45,212,191,0.06); border: 1px solid rgba(45,212,191,0.16); }
        .clark-mover-tag--caution { color: rgba(251,191,36,0.85); background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.16); }
        .clark-mover-tag--accent { color: rgba(196,181,253,0.75); background: rgba(139,92,246,0.06); border: 1px solid rgba(139,92,246,0.14); }
        .clark-mover-change { font: 800 10.5px var(--font-plex-mono); margin-left: auto; flex-shrink: 0; padding-left: 6px; }
        .clark-mover-change.is-up { color: rgba(94,234,212,0.90); }
        .clark-mover-change.is-down { color: rgba(251,113,133,0.90); }
        .clark-mover-row-stats {
          display: flex; align-items: center; gap: 5px; min-width: 0; flex: 1; flex-wrap: wrap; row-gap: 3px;
          font: 600 10px var(--font-plex-mono); color: rgba(255,255,255,0.40);
        }
        .clark-mover-dot { color: rgba(255,255,255,0.18); flex-shrink: 0; }
        .clark-mover-row-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
        .clark-mover-action {
          font: 700 9px var(--font-inter); letter-spacing: .03em; text-transform: uppercase;
          color: rgba(255,255,255,0.36); background: transparent;
          border: 1px solid transparent; border-radius: 6px; padding: 3px 6px;
          cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s;
        }
        .clark-mover-action:hover:not(:disabled) { color: #e2e8f0; background: rgba(139,92,246,0.08); border-color: rgba(139,92,246,0.16); }
        .clark-mover-action.is-active { color: rgba(94,234,212,0.90); background: rgba(45,212,191,0.07); border-color: rgba(45,212,191,0.18); }
        .clark-mover-action:disabled { cursor: default; opacity: 0.6; }

        /* Base Market Read card */
        /* max-width/overflow:hidden here are a defensive backstop, DISCLOSED (Clark right-panel
           layout fix task) — this card only ever renders text nodes (see MarketReadCard/ClarkMessage:
           no <img>/<canvas>/dangerouslySetInnerHTML/markdown-image parsing anywhere in this file), so
           there is no code path that could place a screenshot/thumbnail here; this just guarantees
           nothing this card renders can ever visually escape its own box. */
        .clark-market-card { display: flex; flex-direction: column; max-width: 100%; overflow: hidden; }
        .clark-market-head {
          display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
          padding-bottom: 8px; margin-bottom: 9px; border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .clark-market-title {
          font: 800 11px var(--font-plex-mono); letter-spacing: .08em; text-transform: uppercase;
          color: #f1f5f9;
        }
        .clark-market-title-suffix { color: rgba(196,181,253,0.65); text-transform: none; letter-spacing: normal; }
        .clark-market-subtitle { font-size: 10px; color: rgba(255,255,255,0.42); margin-top: 2px; }
        .clark-market-live-badge {
          flex-shrink: 0; font: 800 8.5px var(--font-plex-mono); letter-spacing: .08em;
          color: #5eead4; background: rgba(45,212,191,0.10); border: 1px solid rgba(45,212,191,0.26);
          border-radius: 999px; padding: 3px 8px; white-space: nowrap;
        }
        .clark-market-shortread {
          margin-top: 11px; padding-left: 10px; border-left: 2px solid rgba(139,92,246,0.24);
          color: rgba(255,255,255,0.56); font-size: 11.5px; line-height: 1.75;
        }
        .clark-market-shortread p { margin: 0 0 5px; }
        .clark-market-shortread p:last-child { margin-bottom: 0; }
        .clark-market-next {
          margin-top: 11px; padding: 9px 10px; border-radius: 8px;
          background: rgba(255,255,255,0.018); border: 1px solid rgba(45,212,191,0.10);
          font-size: 11.5px; line-height: 1.7; color: rgba(255,255,255,0.62);
        }
        .clark-market-next p { margin: 0 0 4px; }
        .clark-market-next-cta {
          margin-top: 4px; font: 700 8.5px var(--font-inter); letter-spacing: .03em; text-transform: uppercase;
          color: rgba(94,234,212,0.85); background: transparent; border: 1px solid rgba(45,212,191,0.18);
          border-radius: 6px; padding: 3px 8px; cursor: pointer; transition: background 0.15s, border-color 0.15s;
        }
        .clark-market-next-cta:hover { background: rgba(45,212,191,0.09); border-color: rgba(45,212,191,0.32); }

        /* Composer — terminal command-bar treatment */
        .clark-quick-chip {
          font: 700 9.5px var(--font-plex-mono); letter-spacing: .03em;
          color: rgba(255,255,255,0.42); background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;
          padding: 3px 7px; cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s;
          white-space: nowrap;
        }
        .clark-quick-chip:hover { color: #5eead4; background: rgba(45,212,191,0.08); border-color: rgba(45,212,191,0.24); }
        .clark-composer-shell {
          background: rgba(6,8,18,0.80);
          border: 1px solid rgba(255,255,255,0.10);
          transition: border-color 0.15s;
        }
        .clark-composer-shell:focus-within { border-color: rgba(45,212,191,0.34); }
        .clark-composer-prompt { color: rgba(94,234,212,0.65); font-family: var(--font-plex-mono); font-size: 12px; flex-shrink: 0; }

        @media (prefers-reduced-motion: reduce) {
          .clark-orb::before, .clark-loading-shimmer, .clark-online-dot { animation: none !important; }
        }
        @media (max-width: 768px) {
          .clark-radar-hdr-blur { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
          .clark-radar-panel-blur { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
          .clark-radar-input-blur { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
        }
      `}</style>

      <div
        className="clark-radar-panel-blur"
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          background: 'rgba(5,8,22,0.72)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          boxShadow: 'inset 0 0 42px rgba(139,92,246,0.05), inset 0 0 20px rgba(236,72,153,0.03)',
        }}
      >
        {/* Top gradient accent line */}
        <div
          style={{
            height: '1.5px',
            background: 'linear-gradient(90deg, transparent 0%, #ff4b9a 25%, #7b5cff 55%, #4ef2c5 80%, transparent 100%)',
            flexShrink: 0,
          }}
        />

        {/* ── Header ──────────────────────────────────────── */}
        <div
          className="clark-radar-hdr-blur"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '9px 12px',
            background: 'rgba(8,10,20,0.90)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}
        >
          {/* Left — icon + title + role subtitle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
            <ClarkOrb size={26} className="clark-orb" style={{ flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#f1f5f9',
                  fontFamily: 'var(--font-inter)',
                  letterSpacing: '-0.01em',
                  lineHeight: 1.2,
                }}
              >
                Clark AI
              </div>
              <div
                style={{
                  fontSize: '8.5px',
                  fontWeight: 700,
                  color: 'rgba(196,181,253,0.55)',
                  fontFamily: 'var(--font-plex-mono)',
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  lineHeight: 1.2,
                  whiteSpace: 'nowrap',
                }}
              >
                Onchain Intelligence Analyst
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <div className='clark-mode-toggle'>
              <button type='button' className={`clark-mode-btn ${clarkMode === 'chat' ? 'active' : ''}`} onClick={() => setClarkMode('chat')}>
                Chat
              </button>
              <button type='button' className={`clark-mode-btn ${clarkMode === 'analyst' ? 'active' : ''}`} onClick={() => setClarkMode('analyst')}>
                Analyst
              </button>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                background: 'rgba(139,92,246,0.08)',
                border: '1px solid rgba(139,92,246,0.20)',
                borderRadius: '100px',
                padding: '3px 9px',
              }}
            >
              <div className="clark-online-dot" style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#a78bfa' }} />
              <span
                style={{
                  fontSize: '9px',
                  fontWeight: 700,
                  letterSpacing: '0.10em',
                  color: '#a78bfa',
                  fontFamily: 'var(--font-plex-mono)',
                }}
              >
                ONLINE
              </span>
            </div>
          </div>
        </div>

        {/* ── Messages area ───────────────────────────────── */}
        <div
          ref={scrollRef}
          className="clark-radar-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {messages.length === 0 ? (
            /* ── Empty / standby state, DISCLOSED (Clark panel empty-message polish task): compact,
               single small orb + one status line instead of a big glowing welcome card — no chat
               history is faked here, this only renders while `messages` is genuinely empty. */
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                padding: '20px 14px',
                gap: '14px',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                <ClarkOrb size={32} className="clark-orb" style={{ boxShadow: '0 0 14px rgba(139,92,246,0.14), 0 0 6px rgba(45,212,191,0.08)' }} />
                <div>
                  <p style={{ fontSize: '12.5px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-inter)', margin: 0, letterSpacing: '-0.005em' }}>
                    Clark is standing by
                  </p>
                  <p style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.42)', fontFamily: 'var(--font-inter)', lineHeight: 1.5, margin: '4px 0 0', maxWidth: '220px' }}>
                    Ask for a token read, wallet scan, LP check, or Base market read.
                  </p>
                </div>
              </div>

              {/* Command chips — same slash commands the composer's quick-chip row uses */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', justifyContent: 'center' }}>
                {['/token', '/wallet', '/lp', '/base'].map((cmd) => (
                  <button key={cmd} type="button" className="clark-quick-chip" onClick={() => applyQuickChip(cmd)}>
                    {cmd}
                  </button>
                ))}
              </div>

              {/* Example prompts */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%' }}>
                {HINT_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    className="clark-hint-chip"
                    onClick={() => sendToClark(chip)}
                  >
                    <span style={{ color: 'rgba(94,234,212,0.55)', fontSize: '11px', flexShrink: 0 }}>→</span>
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Message list */
            <>
              {messages.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  }}
                >
                  {msg.role === 'clark' && msg.text !== 'Clark is thinking...' && (
                    <ClarkOrb
                      size={20}
                      className="clark-orb"
                      thinking={false}
                      style={{ flexShrink: 0, marginRight: '6px', alignSelf: 'flex-end' }}
                    />
                  )}
                  <div
                    className={`${msg.role === 'clark' ? 'clark-msg clark-bubble-clark' : 'clark-bubble-user'}`}
                    style={{
                      maxWidth: msg.role === 'clark' ? '92%' : '84%',
                      padding: '9px 11px',
                      borderRadius: '9px',
                      boxShadow: msg.text === 'Clark is thinking...'
                        ? 'inset 0 0 0 1px rgba(45,212,191,0.05)'
                        : undefined,
                      color: msg.text === 'Clark is thinking...' ? 'rgba(255,255,255,0.45)' : '#dde4f0',
                      fontSize: '12px',
                      lineHeight: 1.75,
                      fontFamily: (msg.text.startsWith('{') || msg.text.startsWith('['))
                        ? 'var(--font-plex-mono)'
                        : 'var(--font-inter), Inter, sans-serif',
                      whiteSpace: (msg.text.startsWith('{') || msg.text.startsWith('[')) ? 'pre-wrap' : undefined,
                      wordBreak: 'break-word',
                      overflowWrap: 'anywhere',
                    }}>
                    <div
                      className={msg.role === 'user' ? 'clark-bubble-role-user' : 'clark-bubble-role-clark'}
                      style={{ marginBottom: '5px', fontFamily: 'var(--font-plex-mono)', fontSize: '9px', fontWeight: 800, letterSpacing: '.14em' }}
                    >
                      {msg.role === 'user' ? 'YOU' : 'CLARK'}
                    </div>
                    {msg.text === 'Clark is thinking...' ? (
                      <ClarkLoadingTrace kind={loadingKind} />
                    ) : msg.role === 'clark' ? (
                      <ClarkMessage
                        text={msg.text}
                        movers={msg.movers}
                        onScan={handleScanMover}
                        onWatch={handleWatchMover}
                        watchStateFor={watchStateFor}
                        onReplyPrompt={() => inputRef.current?.focus()}
                      />
                    ) : msg.text}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* ── Input footer — terminal command-bar treatment ─── */}
        <div
          style={{
            flexShrink: 0,
            padding: '7px 10px 10px',
            borderTop: '1px solid rgba(255,255,255,0.07)',
            background: 'rgba(8,10,20,0.80)',
          }}
        >
          {/* Quick command chips */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '6px', overflowX: 'auto' }}>
            {['/token', '/wallet', '/lp', '/base'].map((cmd) => (
              <button key={cmd} type="button" className="clark-quick-chip" onClick={() => applyQuickChip(cmd)}>
                {cmd}
              </button>
            ))}
          </div>

          <div
            className="clark-radar-input-blur clark-composer-shell"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              borderRadius: '9px',
              padding: '8px 8px 8px 11px',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
            }}
          >
            <span className="clark-composer-prompt">{'>_'}</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !loading) handleSend() }}
              disabled={loading}
              placeholder={clarkMode === 'chat' ? 'Ask Clark about a token, wallet, or Base move…' : 'Paste a Base contract or wallet address to analyze…'}
              className="clark-panel-input"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#e2e8f0',
                fontSize: '12px',
                fontFamily: 'var(--font-plex-mono)',
                caretColor: '#5eead4',
                minWidth: 0,
                opacity: loading ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className={input.trim() && !loading ? 'clark-radar-send' : undefined}
              style={{
                flexShrink: 0,
                width: '26px',
                height: '26px',
                borderRadius: '7px',
                background: input.trim() && !loading
                  ? 'linear-gradient(135deg, #2DD4BF, #8b5cf6)'
                  : 'rgba(255,255,255,0.05)',
                border: input.trim() && !loading
                  ? '1px solid rgba(45,212,191,0.36)'
                  : '1px solid rgba(255,255,255,0.07)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: input.trim() && !loading ? 'pointer' : 'default',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 12h14M13 6l6 6-6 6"
                  stroke={input.trim() && !loading ? '#04101a' : 'rgba(255,255,255,0.22)'}
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <p
            style={{
              marginTop: '6px',
              fontSize: '9px',
              color: 'rgba(255,255,255,0.15)',
              fontFamily: 'var(--font-plex-mono)',
              textAlign: 'center',
              letterSpacing: '0.08em',
            }}
          >
            POWERED BY CORTEX ENGINE
          </p>
        </div>

      </div>
    </>
  )
}
