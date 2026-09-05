// CLARK TICKER OPTION SELECTION FIX, DISCLOSED — reported: user sends "/token cashcat", Clark shows
// CASHCAT matches, user clicks/types "scan 1", Clark scans the wrong token (Base Juice/BASEJUICE).
//
// Root cause and fix are fully disclosed in lib/server/clarkTickerSelection.ts's own header and
// tests/clark-ticker-selection.test.ts (the pure resolver logic). This file locks in the WIRING —
// that the live route actually uses that resolver, in the right order, at every place a ticker
// picker is built or consumed — using the same "read the real source, assert on it directly"
// convention as the file's other *.staticCheck.test.ts siblings (app/api/clark/route.ts is far too
// large and provider-dependent for a fixture-based request/response test).
//
// Run directly with:
//   npx tsx --test app/api/clark/tickerOptionSelection.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')

describe('a structured ticker-option selection (button click) is checked before anything else, and never touches activeToken', () => {
  it('imports the shared ticker-selection resolver instead of re-deriving picker logic ad hoc', () => {
    assert.match(src, /from "@\/lib\/server\/clarkTickerSelection"/)
    for (const fn of ['generateTickerSearchId', 'buildTickerPickerOptions', 'resolveTickerSelection', 'parseTypedTickerOptionIndex', 'buildTickerSelectionAudit']) {
      assert.match(src, new RegExp(fn), `must import ${fn}`)
    }
  })

  it('body.tickerSelection is handled before the legacy lastTickerMatches fallback', () => {
    const structuredIndex = src.indexOf('if (body.tickerSelection)')
    const legacyIndex = src.indexOf('if (sessionMem.lastTickerMatches?.length)')
    assert.notEqual(structuredIndex, -1, 'structured ticker-selection handling must exist')
    assert.notEqual(legacyIndex, -1, 'legacy typed "scan N" fallback must still exist')
    assert.ok(structuredIndex < legacyIndex, 'structured selection must be checked BEFORE the legacy text-based fallback')
    const block = src.slice(structuredIndex, legacyIndex)
    assert.match(block, /resolveTickerSelection\(\{/)
    assert.match(block, /buildTickerSelectionAudit\(\{/)
  })

  it('the resolveTickerSelection call itself is built only from selection + session ticker state — never from lastToken/activeToken', () => {
    const callIdx = src.indexOf('resolveTickerSelection({')
    assert.notEqual(callIdx, -1)
    const callBlock = src.slice(callIdx, src.indexOf('});', callIdx))
    assert.doesNotMatch(callBlock, /lastToken|activeToken/i, 'the selection resolver call must take only `selection` + the current ticker searchId/matches — never activeToken/lastToken')
    assert.match(callBlock, /selection,/)
    assert.match(callBlock, /currentSearchId: sessionMem\.lastTickerSearchId/)
    assert.match(callBlock, /currentMatches: sessionMem\.lastTickerMatches/)
  })

  it('within the ticker-selection block, lastToken/activeToken is recorded in the audit trail only — never used to pick which match is scanned', () => {
    // Scoped to the ticker-selection block itself (not the whole 16k-line route file, which has
    // its own unrelated, legitimate sessionMem.lastToken reads for other follow-up features) —
    // every sessionMem.lastToken read in THIS block must be for the audit trail only.
    const structuredIndex = src.indexOf('if (body.tickerSelection)')
    const legacyIndex = src.indexOf('if (sessionMem.lastTickerMatches?.length)')
    const legacyBlockEnd = src.indexOf('\n  }\n', src.indexOf('if (picked) {', legacyIndex)) + 5
    const tickerBlock = src.slice(structuredIndex, legacyBlockEnd)
    const lastTokenRefs = [...tickerBlock.matchAll(/sessionMem\.lastToken\?\.address/g)]
    assert.ok(lastTokenRefs.length >= 2, 'expected the two audit-trail reads of sessionMem.lastToken (structured + typed-fallback paths)')
    for (const m of lastTokenRefs) {
      const lineStart = tickerBlock.lastIndexOf('\n', m.index ?? 0) + 1
      const lineEnd = tickerBlock.indexOf('\n', m.index ?? 0)
      const line = tickerBlock.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      assert.match(line, /previousActiveToken:/, `every sessionMem.lastToken read in the ticker-selection block must be for the audit trail only, found: ${line.trim()}`)
    }
  })

  it('a resolved selection scans the picked match, and clears both lastTickerMatches and lastTickerSearchId together', () => {
    const idx = src.indexOf('if (resolution.status === "resolved" && resolution.selectedMatch)')
    assert.notEqual(idx, -1)
    const block = src.slice(idx, idx + 700)
    assert.match(block, /sessionMem\.lastTickerMatches = undefined;/)
    assert.match(block, /sessionMem\.lastTickerSearchId = null;/)
    assert.match(block, /prompt: `\/token \$\{picked\.tokenAddress\} on \$\{pickedChain\}`/)
  })

  it('a stale or unverifiable selection returns an honest message and never falls through to a scan', () => {
    const idx = src.indexOf("Never silently scan a different token when the selection can't be verified")
    assert.notEqual(idx, -1)
    const block = src.slice(idx, idx + 700)
    assert.match(block, /That option is from an earlier search/)
    assert.match(block, /tickerSelectionAudit,/)
  })
})

describe('every ticker-picker render site writes matches + a fresh, unique searchId atomically, and renders real Scan-N buttons', () => {
  it('the /token <symbol> ambiguous-resolution branch (the exact branch the bug was reported on) generates a fresh searchId and uses buildTickerPickerOptions for its buttons', () => {
    const idx = src.indexOf('Multiple or low-confidence matches found for')
    assert.notEqual(idx, -1)
    const before = src.slice(Math.max(0, idx - 900), idx)
    assert.match(before, /const tickerSearchId = generateTickerSearchId\(\);/)
    assert.match(before, /sessionMem\.lastTickerMatches = options;/)
    assert.match(before, /sessionMem\.lastTickerSearchId = tickerSearchId;/)
    const after = src.slice(idx, idx + 600)
    assert.match(after, /actions: buildTickerPickerOptions\(options, tickerSearchId\)/)
  })

  it('the executeClarkToolPlan tokenResolve branch (the SECOND, independent resolver path) writes the same atomic pair', () => {
    const idx = src.indexOf('sessionMem.lastTickerMatches = evidence.tokenResolve.matches.map')
    assert.notEqual(idx, -1)
    const elseIdx = src.indexOf('} else if (evidence.tokenResolve?.selected)', idx)
    assert.notEqual(elseIdx, -1)
    const setBlock = src.slice(idx, elseIdx)
    assert.match(setBlock, /sessionMem\.lastTickerSearchId = generateTickerSearchId\(\);/)
    const clearBlock = src.slice(elseIdx, elseIdx + 200)
    assert.match(clearBlock, /sessionMem\.lastTickerMatches = undefined;/)
    assert.match(clearBlock, /sessionMem\.lastTickerSearchId = null;/)
  })

  it('both duplicate "Multiple tokens found for" display sites render Scan-N buttons from the same session-stored searchId', () => {
    const matches = [...src.matchAll(/Multiple tokens found for \$\{evidence\.tokenResolve\.query\.toUpperCase\(\)\}/g)]
    assert.ok(matches.length >= 2, 'expected at least two display sites (the known duplicate)')
    for (const m of matches) {
      const idx = m.index ?? 0
      const nearby = src.slice(idx, idx + 600)
      assert.match(nearby, /ui: sessionMem\.lastTickerSearchId \? \{ intentBadge: "Choose token", actions: buildTickerPickerOptions\(sessionMem\.lastTickerMatches/, 'each display site must render buttons from the session-stored (matches, searchId) pair')
    }
  })

  it('the chain-narrowing re-picker also mints a fresh searchId for its renumbered list', () => {
    const idx = src.indexOf('chainMatches.length > 1')
    assert.notEqual(idx, -1)
    const block = src.slice(idx, idx + 1200)
    assert.match(block, /const narrowedSearchId = generateTickerSearchId\(\);/)
    assert.match(block, /actions: buildTickerPickerOptions\(chainMatches, narrowedSearchId\)/)
  })

  it('an explicit new /token command clears lastTickerMatches and lastTickerSearchId together, never one without the other', () => {
    const idx = src.indexOf('if (explicitTokenCommand) { sessionMem.lastTickerMatches = undefined; sessionMem.lastTickerSearchId = null; }')
    assert.notEqual(idx, -1, 'the POST-level explicit /token clear must reset both fields atomically')
  })
})

describe('ClarkSessionMemory stores lastTickerMatches/lastTickerSearchId as one atomic, shared-type pair', () => {
  it('lastTickerMatches uses the shared ClarkTickerMatch type, and lastTickerSearchId sits next to it', () => {
    assert.match(src, /lastTickerMatches\?: ClarkTickerMatch\[\];/)
    assert.match(src, /lastTickerSearchId\?: string \| null;/)
  })
})

describe('client wiring — page.tsx echoes the exact button payload back, never re-deriving it from text', () => {
  const pageSrc = readFileSync(fileURLToPath(new URL('../../terminal/clark-ai/page.tsx', import.meta.url)), 'utf8')

  it('ClarkAction carries the optional structured ticker-selection fields', () => {
    assert.match(pageSrc, /tickerSearchId\?: string; optionIndex\?: number; tokenAddress\?: string; chainId\?: number \| null/)
  })

  it('handleSendText accepts and forwards a tickerSelection payload to the request body', () => {
    assert.match(pageSrc, /async function handleSendText\(raw: string, tickerSelection\?:/)
    assert.match(pageSrc, /\.\.\.\(tickerSelection \? \{ tickerSelection \} : \{\}\),/)
  })

  it('the action button click handler builds tickerSelection from the action itself, not from the prompt text', () => {
    const idx = pageSrc.indexOf('const tickerSelection = action.tickerSearchId && action.tokenAddress')
    assert.notEqual(idx, -1)
    const block = pageSrc.slice(idx, idx + 600)
    assert.match(block, /optionIndex: action\.optionIndex \?\? 0/)
    assert.match(block, /tokenAddress: action\.tokenAddress/)
    assert.match(block, /chainId: action\.chainId \?\? null/)
    assert.match(block, /void handleSendText\(action\.prompt as string, tickerSelection\)/)
  })
})

console.log('tickerOptionSelection.staticCheck.test.ts: source assertions passed')
