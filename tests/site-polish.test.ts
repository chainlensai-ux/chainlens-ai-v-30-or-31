// Source checks for two site-wide rendering fixes (same source-scan convention as
// app/terminal/wallet-scanner/page.scanStaleness.test.ts):
//  - Tailwind 4 ignores the v3 `@tailwind base` directive, so its reset never loads; globals.css must zero the
//    body margin itself, or every page is shifted 8px and clipped 8px on the right.
//  - ConnectWallet must render one placeholder until mount: wagmi's server state ('reconnecting') differs from
//    the browser's first render ('disconnected'), which threw hydration error #418 on /terminal.
//   npx tsx --test tests/site-polish.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('globals.css zeroes the body margin that the missing Tailwind reset would have', () => {
  const css = read('app/globals.css')
  assert.match(css, /html, body \{[^}]*\bmargin: 0;/)
})

test('globals.css keeps a keyboard focus ring despite the global *:focus reset', () => {
  const css = read('app/globals.css')
  assert.match(css, /:is\(a, button[^{]*\):focus-visible \{\s*outline: 2px solid/)
})

test('ConnectWallet renders a mount placeholder before any wagmi-state branch', () => {
  const src = read('components/ConnectWallet.tsx')
  const placeholder = src.indexOf('if (!mounted) {\n    return (')
  assert.ok(placeholder > 0, 'expected the pre-mount placeholder')
  assert.ok(placeholder < src.indexOf('if (isConnected && address) {'), 'placeholder must precede the connected branch')
  assert.ok(placeholder < src.indexOf('Reconnecting wallet…'), 'placeholder must precede the reconnecting branch')
})
