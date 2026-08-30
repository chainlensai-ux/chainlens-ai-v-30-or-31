// Static Clark AI page config extracted so page.tsx stays under the GitHub MCP write limit.

export type Mode = { key: 'token' | 'wallet' | 'contract' | 'radar'; label: string; helper: string; prompt: string; icon: string }
export const MODES: Mode[] = [
  { key: 'token',    label: 'Token Analysis', helper: 'Evaluate token quality, momentum, and risk on Base.',          prompt: 'Analyze this Base token and give me WATCH, AVOID, or SCAN DEEPER with key reasons.', icon: '◈' },
  { key: 'wallet',   label: 'Wallet Analysis', helper: 'Break down holdings, behavior, concentration, and recent activity.', prompt: 'Analyze this Base wallet. Focus on behavior, concentration risk, and recent activity.', icon: '◎' },
  { key: 'contract', label: 'Contract Risk',   helper: 'Review privilege flags, liquidity traps, and suspicious mechanics.', prompt: 'Run a contract risk analysis on this Base token contract. Highlight red flags clearly.', icon: '⚠' },
  { key: 'radar',    label: 'Base Radar',       helper: 'Use imported Base Radar signal context for a concise verdict.',       prompt: 'Use my imported Base Radar context and give a concise WATCH / AVOID / SCAN DEEPER verdict.', icon: '⟲' },
]

export const ANALYST_CHIPS = [
  { label: "What's pumping on Base?", prompt: "What's pumping on Base?" },
  { label: '/wallet',                 prompt: '/wallet '                 },
  { label: '/lp',                     prompt: '/lp '                     },
  { label: '/token',                  prompt: '/token '                  },
]
export const CHAT_CHIPS = [
  { label: 'Who deployed VIRTUAL?',  prompt: 'Who deployed VIRTUAL?'         },
  { label: 'Show Base whales',        prompt: 'Show Base whales'              },
  { label: 'Top movers today',        prompt: 'Top movers on Base today'       },
  { label: 'Base activity',           prompt: 'Latest activity on Base?'      },
]

export type AnalysisKind = 'token' | 'wallet' | 'lp' | 'general'
export const ANALYSIS_STAGES: Record<AnalysisKind, string[]> = {
  token: ['Analyzing token...', 'Checking liquidity...', 'Reviewing holder distribution...', 'Inspecting security signals...', 'Building CORTEX summary...'],
  wallet: ['Loading portfolio...', 'Reviewing activity...', 'Checking chain exposure...', 'Building wallet profile...', 'Preparing intelligence report...'],
  lp: ['Reviewing liquidity...', 'Checking LP control...', 'Analyzing concentrated positions...', 'Preparing LP report...'],
  general: ['Parsing request...', 'Loading CORTEX context...', 'Reviewing Base signals...', 'Preparing intelligence report...'],
}
export function inferAnalysisKind(text: string, mode?: Mode['key']): AnalysisKind {
  const t = text.toLowerCase()
  if (mode === 'wallet' || /\b(wallet|portfolio|holdings?|pnl|whale)\b/.test(t)) return 'wallet'
  if (/\b(lp|liquidity|pool|lock|unlock|concentrated)\b/.test(t)) return 'lp'
  if (mode === 'token' || mode === 'contract' || /\b(token|contract|ca\b|holders?|deployer|rug|safe|scan)\b/.test(t)) return 'token'
  return 'general'
}

export const START_WITH_CHIPS = [
  { label: '/token', prompt: '/token ' },
  { label: '/wallet', prompt: '/wallet ' },
  { label: '/lp', prompt: '/lp ' },
  { label: 'Base Movers', prompt: "What's pumping on Base?" },
]

export const QUICK_ACTIONS = [
  { title: 'Market movers', sub: 'Find Base momentum.', icon: '◈', accent: '#22d3ee', prompt: "What's pumping on Base?" },
  { title: 'Scan token', sub: 'Run token intelligence.', icon: '◎', accent: '#2dd4bf', prompt: 'Scan BRETT' },
  { title: 'Wallet read', sub: 'Analyze wallet behavior.', icon: '▣', accent: '#a78bfa', prompt: 'Show Base whales' },
  { title: 'LP safety', sub: 'Check liquidity control.', icon: '⌘', accent: '#22d3ee', prompt: 'Liquidity check AERO' },
]

export const CLARK_DAILY_LIMITS: Record<string, number> = { free: 5, pro: 50, elite: 300 }
export const CLARK_LIMIT_UNAUTH = 3
function getTodayStr() { return new Date().toISOString().slice(0, 10) }
export function readClarkUsage(): number {
  if (typeof window === 'undefined') return 0
  try {
    const raw = localStorage.getItem('chainlens:clark:daily-usage')
    if (!raw) return 0
    const { date, count } = JSON.parse(raw) as { date: string; count: number }
    return date === getTodayStr() ? (count || 0) : 0
  } catch { return 0 }
}
export function bumpClarkUsage(): number {
  try {
    const next = readClarkUsage() + 1
    localStorage.setItem('chainlens:clark:daily-usage', JSON.stringify({ date: getTodayStr(), count: next }))
    return next
  } catch { return 0 }
}
export function decodePrompt(value: string | null): string | null {
  if (!value) return null
  try { return decodeURIComponent(value) } catch { return value }
}
