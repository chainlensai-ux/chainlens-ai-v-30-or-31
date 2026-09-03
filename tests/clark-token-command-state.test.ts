import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { doesClarkTokenResponseMatch, parseClarkTokenCommand } from '../lib/clark/commandFormats'
import { createClarkRequestGate } from '../lib/client/clarkRequestLifecycle'

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

test('/token current contract wins over the previous active token', () => {
  const command = parseClarkTokenCommand(`/token ${B}`)
  assert.ok(command)
  assert.equal(command.address, B)
  assert.equal(doesClarkTokenResponseMatch(command, A, B), true)
  assert.equal(doesClarkTokenResponseMatch(command, A, A), false)
})

test('newer in-flight /token request makes older response stale', () => {
  const gate = createClarkRequestGate()
  const first = gate.begin(`/token ${A}`)
  const second = gate.begin(`/token ${B}`)
  assert.equal(first.proceed, true)
  assert.equal(second.proceed, true)
  if (first.proceed && second.proceed) {
    assert.equal(first.abortSignal.aborted, true)
    assert.equal(gate.shouldApply(first.requestId), false)
    assert.equal(gate.shouldApply(second.requestId), true)
  }
})

test('fresh ticker does not accept the old active token as its response', () => {
  const command = parseClarkTokenCommand('/token BRETT')
  assert.ok(command)
  assert.equal(command.ticker, 'BRETT')
  assert.equal(doesClarkTokenResponseMatch(command, A, A), false)
  assert.equal(doesClarkTokenResponseMatch(command, A, B), true)
  assert.equal(doesClarkTokenResponseMatch(command, A, B, true), false)
})

test('Clark client and API keep explicit /token state isolated from stale context', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const page = fs.readFileSync(path.join(root, 'app/terminal/clark-ai/page.tsx'), 'utf8')
  const route = fs.readFileSync(path.join(root, 'app/api/clark/route.ts'), 'utf8')
  assert.match(page, /selectedToken: tokenCommand \? null/)
  assert.match(page, /currentTokenAddress: tokenCommand \? null/)
  assert.match(page, /clarkTokenCommandAudit/)
  assert.match(route, /parseClarkTokenCommand\(body\.prompt \?\? ''\)/)
  assert.match(route, /response_token_did_not_match_current_token_command/)
  assert.match(route, /Boolean\(explicitTokenCommand\) \|\|/)
  assert.match(route, /slashCmd\.bare && slashFill\.address/)
  assert.match(route, /clarkTokenPickerRequired: true/)
  assert.match(route, /clarkTokenScanFailed: true/)
  assert.match(route, /responseTokenChain/)
})
