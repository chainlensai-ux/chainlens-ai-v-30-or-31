// Presentation-only parser for Clark reply text. Clark's server replies are plain text in a
// loose report shape ("Verdict: …", "Confidence: …", "Main risks:" headings, "- " bullets, a
// "Not financial advice" line). This splits that text into display blocks so the page can show
// labelled sections instead of one pre-wrapped wall of text.
//
// It never invents or drops content: every non-blank input line lands in exactly one block, with
// its text unchanged apart from the bullet marker / trailing heading colon. Anything that does not
// match a known shape is a plain paragraph, so free-form chat replies render as before.

export type ClarkTone = 'risk' | 'caution' | 'ok' | 'neutral'

export type ClarkReplyBlock =
  | { kind: 'verdict'; label: string; value: string; tone: ClarkTone }
  | { kind: 'field'; label: string; value: string }
  | { kind: 'heading'; text: string; tone: ClarkTone }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'paragraph'; text: string }
  | { kind: 'disclaimer'; text: string }

const BULLET_RE = /^\s*(?:[-•*]|·)\s+(.*)$/
const ORDERED_RE = /^\s*(\d{1,2})[.)]\s+(.*)$/
// "Main risks:", "What ChainLens checked:", "Dev / deployer risk:" — short, no sentence punctuation.
const HEADING_RE = /^([A-Z][A-Za-z0-9 /&'(),+-]{1,46}):\s*$/
// "Verdict: WATCH", "Confidence: Medium" — a short label followed by a value on the same line.
const FIELD_RE = /^([A-Z][A-Za-z0-9 /&'()-]{1,26}):\s+(\S.*)$/
const VERDICT_LABELS = new Set(['verdict', 'confidence', 'status', 'risk level', 'evidence', 'evidence status', 'signal'])
const DISCLAIMER_RE = /^(?:not financial advice|nfa\b|this is not financial advice|disclaimer)/i

/**
 * Tone of a verdict/confidence value, read only from the leading word(s) Clark actually returned
 * ("WATCH — no critical red flag…" is a WATCH, whatever words follow the dash).
 */
export function clarkValueTone(value: string): ClarkTone {
  const v = value.trim().toLowerCase()
  if (/^(avoid|high risk|do not|honeypot|rug|danger|critical)\b/.test(v)) return 'risk'
  if (/^(watch|open check|scan deeper|partial|incomplete|unverified|pending|medium|low|caution|missing)\b/.test(v)) return 'caution'
  if (/^(trustworthy|high|verified|confirmed|pass(?:ed)?|clean)\b/.test(v)) return 'ok'
  return 'neutral'
}

function headingTone(text: string): ClarkTone {
  const t = text.toLowerCase()
  if (/\b(risks?|red flags?|warnings?|danger)\b/.test(t)) return 'risk'
  if (/\b(missing|gaps?|unavailable|open|watch|verify|next)\b/.test(t)) return 'caution'
  if (/\b(signals?|bullish|positives?|strengths?)\b/.test(t)) return 'ok'
  return 'neutral'
}

export function parseClarkReply(text: string): ClarkReplyBlock[] {
  const blocks: ClarkReplyBlock[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'paragraph', text: para.join('\n') })
    para = []
  }
  const flushList = () => {
    if (list && list.items.length) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
    list = null
  }

  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) { flushPara(); flushList(); continue }

    const bullet = line.match(BULLET_RE)
    const ordered = bullet ? null : line.match(ORDERED_RE)
    if (bullet || ordered) {
      flushPara()
      const isOrdered = Boolean(ordered)
      if (!list || list.ordered !== isOrdered) { flushList(); list = { ordered: isOrdered, items: [] } }
      list.items.push((bullet ? bullet[1] : ordered![2]).trim())
      continue
    }
    flushList()

    const trimmed = line.trim()
    if (DISCLAIMER_RE.test(trimmed)) { flushPara(); blocks.push({ kind: 'disclaimer', text: trimmed }); continue }

    const heading = trimmed.match(HEADING_RE)
    if (heading) {
      flushPara()
      blocks.push({ kind: 'heading', text: heading[1].trim(), tone: headingTone(heading[1]) })
      continue
    }

    const field = trimmed.match(FIELD_RE)
    if (field && !/https?:$/i.test(field[1])) {
      flushPara()
      const label = field[1].trim()
      const value = field[2].trim()
      if (VERDICT_LABELS.has(label.toLowerCase())) blocks.push({ kind: 'verdict', label, value, tone: clarkValueTone(value) })
      else blocks.push({ kind: 'field', label, value })
      continue
    }

    para.push(trimmed)
  }
  flushPara()
  flushList()
  return blocks
}

export type ClarkInlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'address'; text: string }
  | { kind: 'link'; text: string; href: string }

const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|0x[a-fA-F0-9]{40}\b|0x[a-fA-F0-9]{64}\b)/g

/** Splits one line into text / **bold** / `code` / URL / 0x-address parts (text is never altered). */
export function parseClarkInline(text: string): ClarkInlinePart[] {
  const parts: ClarkInlinePart[] = []
  let last = 0
  for (const m of String(text ?? '').matchAll(INLINE_RE)) {
    const token = m[0]
    const at = m.index ?? 0
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) })
    if (token.startsWith('**')) parts.push({ kind: 'strong', text: token.slice(2, -2) })
    else if (token.startsWith('`')) parts.push({ kind: 'code', text: token.slice(1, -1) })
    else if (token.startsWith('http')) parts.push({ kind: 'link', text: token, href: token })
    else parts.push({ kind: 'address', text: token })
    last = at + token.length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}
