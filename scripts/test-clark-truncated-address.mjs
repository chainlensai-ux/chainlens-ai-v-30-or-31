import assert from 'node:assert/strict'
import fs from 'node:fs'

// TRUNCATED-ADDRESS FIX, DISCLOSED.
//
// Reported live: "Who deployed 0xB2000000000000000000000004c27f652382f41D01?" — a malformed
// 42-hex-character string (one too many for a real EVM address) — silently produced a WRONG
// answer: a token scan for "Unknown token" with every field "No signal", then a follow-up
// "who deployed" question answering with unrelated WALLET PORTFOLIO data instead of deployer info
// or an honest "invalid address" message.
//
// Root cause, confirmed by testing the actual regex against the actual reported string: every
// address-extraction regex in Clark's pipeline was unanchored — /0x[a-fA-F0-9]{40}/ with no
// lookahead — so it silently matched only the FIRST 40 of the 42 hex characters, producing a
// DIFFERENT, WRONG 40-char address. Every downstream lookup (entity-type check, token scan,
// deployer resolution) then ran against that wrong address instead of the one the user actually
// pasted, and instead of failing with an honest "that doesn't look like a valid address" message.
// This explains why the entity-routing gate (shipped in an earlier commit this session) didn't
// catch it: it correctly resolved the WRONG address's real on-chain type — it never knew the
// address itself was already corrupted before the gate saw it.
//
// Fix: every extraction regex gets a negative lookahead (?![a-fA-F0-9]) so a 41+-char hex run
// fails to match AT ALL (returns null / "no address found") instead of being silently truncated
// into a different real-looking address. Verified computationally (not just asserted) below.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')

assert.match(routeSrc, /function extractAddress\(text: string\): string \| null \{/, 'extractAddress must exist')
assert.ok(routeSrc.includes('const match = text.match(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/);'), 'extractAddress must use the lookahead-guarded pattern')

// Computational proof, not just a source-text check: the exact reported malformed address must
// fail to extract at all, and a real 40-char address must still extract correctly.
const SAFE_RE = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/
const UNSAFE_RE = /0x[a-fA-F0-9]{40}/

const MALFORMED = '0xB2000000000000000000000004c27f652382f41D01' // 42 hex chars — the exact reported string
assert.equal(MALFORMED.replace('0x', '').length, 42, 'sanity check: the reported address really is 42 hex chars, not 40')

// Prove the OLD behavior was actually broken (not a hypothetical).
const oldMatch = `Who deployed ${MALFORMED}`.match(UNSAFE_RE)?.[0]
assert.ok(oldMatch, 'the old unanchored regex must reproduce the bug (a match occurs)')
assert.notEqual(oldMatch, MALFORMED, 'the old regex must have silently truncated the address into a DIFFERENT one — this is the actual bug')
assert.equal(oldMatch.length, 42, 'the truncated match itself is still 42 chars long (0x + 40 hex) — just the WRONG 40 hex chars')

// Prove the FIX: the malformed address must now fail to extract at all.
assert.equal(`Who deployed ${MALFORMED}`.match(SAFE_RE), null, 'the fixed regex must reject the malformed address entirely, never silently coerce it into a wrong one')

// Prove the fix doesn't break real, well-formed addresses.
const REAL_ADDRESS = '0x1234567890123456789012345678901234567890'
assert.equal(REAL_ADDRESS.replace('0x', '').length, 40, 'sanity check: this control address really is 40 hex chars')
assert.equal(`Who deployed ${REAL_ADDRESS}?`.match(SAFE_RE)?.[0], REAL_ADDRESS, 'a real, well-formed address must still extract correctly')

// Every other address-extraction site touched by this fix, across the files that feed Clark's
// intent/entity resolution — all must use the same lookahead-guarded pattern, not just the one
// site that happened to reproduce the reported symptom.
const filesAndConstants = [
  ['lib/clarkIntent.ts', 'ADDRESS_RE'],
  ['lib/server/clarkAnalystIntent.ts', 'ADDRESS_RE'],
  ['lib/server/clarkContextResolver.ts', 'EVM_ADDRESS_RE'],
  ['lib/server/clarkHistory.ts', 'ADDRESS_RE'],
  ['lib/server/clarkBasicIntent.ts', 'ADDRESS_RE'],
]
for (const [file, constName] of filesAndConstants) {
  const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  assert.match(
    src,
    new RegExp(`const ${constName} = /0x\\[a-fA-F0-9\\]\\{40\\}\\(\\?!\\[a-fA-F0-9\\]\\)/`),
    `${file}'s ${constName} must use the lookahead-guarded pattern — this feeds Clark's intent/entity classification with the exact same truncation exposure`,
  )
}

// The one extraction site inside a multi-alternative match (extractLastTokenContext, reading a
// prior turn back out of conversation history) must carry the guard on every alternative, not
// just the first.
const lookaheadGuard = '(?![a-fA-F0-9])'
const guardedAlternatives = [
  'line.match(/Contract:\\s*(0x[a-fA-F0-9]{40}(?![a-fA-F0-9]))/i)',
  'line.match(/Token resolved:[^\\n]*\\((0x[a-fA-F0-9]{40}(?![a-fA-F0-9]))\\)/i)',
  'line.match(/^\\s*\\d+\\.\\s+[^\\n]*?(0x[a-fA-F0-9]{40}(?![a-fA-F0-9]))/m)',
  'line.match(/(0x[a-fA-F0-9]{40}(?![a-fA-F0-9]))/)',
]
for (const alt of guardedAlternatives) {
  assert.ok(routeSrc.includes(alt), `extractLastTokenContext must guard this alternative with ${lookaheadGuard}: ${alt}`)
}

console.log('test-clark-truncated-address.mjs: all assertions passed')
