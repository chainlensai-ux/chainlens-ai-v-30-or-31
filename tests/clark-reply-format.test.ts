import assert from 'node:assert/strict'
import test from 'node:test'
import { clarkValueTone, parseClarkInline, parseClarkReply, type ClarkReplyBlock } from '../lib/client/clarkReplyFormat'

// Every non-blank input line must survive parsing with its words intact (presentation only).
function blockText(b: ClarkReplyBlock): string[] {
  switch (b.kind) {
    case 'verdict':
    case 'field': return [`${b.label}: ${b.value}`]
    case 'heading': return [`${b.text}:`]
    case 'list': return b.items
    case 'paragraph': return b.text.split('\n')
    case 'disclaimer': return [b.text]
  }
}

const TOKEN_REPORT = [
  'Verdict: WATCH — no critical red flag confirmed by checked evidence',
  'Confidence: Medium-Low',
  '',
  'What ChainLens checked:',
  '- Token scan: ok',
  '- Liquidity / LP control: partial',
  '',
  'Main risks:',
  '- LP/control data is missing; missing is not safe.',
  '',
  'Missing evidence:',
  '- Holder concentration',
  '',
  'Not financial advice: this is an evidence report, not a trade call.',
].join('\n')

test('token report splits into verdict, headings, lists and disclaimer', () => {
  const blocks = parseClarkReply(TOKEN_REPORT)
  assert.deepEqual(blocks.map((b) => b.kind), ['verdict', 'verdict', 'heading', 'list', 'heading', 'list', 'heading', 'list', 'disclaimer'])
  const [verdict, confidence] = blocks
  assert.equal(verdict.kind === 'verdict' && verdict.tone, 'caution', 'WATCH is caution even though the sentence mentions "critical"')
  assert.equal(confidence.kind === 'verdict' && confidence.tone, 'caution')
  const risks = blocks[4]
  assert.equal(risks.kind === 'heading' && risks.tone, 'risk')
  const missing = blocks[6]
  assert.equal(missing.kind === 'heading' && missing.tone, 'caution')
})

test('no line is dropped or reworded', () => {
  const input = TOKEN_REPORT.split('\n').filter((l) => l.trim()).map((l) => l.replace(/^-\s+/, ''))
  const output = parseClarkReply(TOKEN_REPORT).flatMap(blockText)
  assert.deepEqual(output, input)
})

test('free-form chat replies stay a paragraph', () => {
  const reply = "Hey! I can scan a token, read a wallet, or explain LP control. What should I look at?"
  assert.deepEqual(parseClarkReply(reply), [{ kind: 'paragraph', text: reply }])
})

test('ordered lists and mixed paragraphs', () => {
  const blocks = parseClarkReply('Top movers right now.\n1. AERO — volume up\n2. BRETT — liquidity steady\nScan one with "scan 1".')
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph', 'list', 'paragraph'])
  assert.equal(blocks[1].kind === 'list' && blocks[1].ordered, true)
})

test('value tone reads only the leading words', () => {
  assert.equal(clarkValueTone('HIGH RISK / DO NOT ASSUME SAFE'), 'risk')
  assert.equal(clarkValueTone('AVOID'), 'risk')
  assert.equal(clarkValueTone('High'), 'ok')
  assert.equal(clarkValueTone('TRUSTWORTHY'), 'ok')
  assert.equal(clarkValueTone('Low'), 'caution')
  assert.equal(clarkValueTone('OPEN CHECK — evidence incomplete'), 'caution')
  assert.equal(clarkValueTone('UNAVAILABLE'), 'neutral')
})

test('inline parts: bold, code, links and addresses keep their exact text', () => {
  const addr = '0x5bE75e3b0aFf5D1A042A5363Ae36AcB1d6d755ea'
  const parts = parseClarkInline(`**Note** see https://basescan.org/token/${addr}. Contract ${addr} uses \`transfer\`.`)
  assert.deepEqual(parts.map((p) => p.kind), ['strong', 'text', 'link', 'text', 'address', 'text', 'code', 'text'])
  assert.equal(parts.map((p) => p.text).join(''), `Note see https://basescan.org/token/${addr}. Contract ${addr} uses transfer.`)
  assert.equal(parts[2].kind === 'link' && parts[2].href, `https://basescan.org/token/${addr}`)
})
