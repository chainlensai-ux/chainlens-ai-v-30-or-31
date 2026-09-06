import assert from 'node:assert/strict'
import fs from 'node:fs'

// Clark/CORTEX audit Item 7: client memory is namespaced per chat. New chat / switch / delete
// cannot leak the previous active token/wallet/list. Same-chat memory still persists.

const memorySrc = fs.readFileSync(new URL('../lib/client/clarkMemory.ts', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/clark-ai/page.tsx', import.meta.url), 'utf8')

assert.match(memorySrc, /export function clearClarkMemory\(/, 'clearClarkMemory must exist')
assert.match(memorySrc, /export function saveClarkMemoryForChat\(/, 'per-chat snapshot save must exist')
assert.match(memorySrc, /export function loadClarkMemoryForChat\(/, 'per-chat snapshot load must exist')
assert.match(memorySrc, /export function deleteClarkMemoryForChat\(/, 'per-chat snapshot delete must exist')
assert.match(memorySrc, /chainlens:clark:chat:\$\{chatId\}:memory/, 'chat snapshots are namespaced by chat id')
assert.match(memorySrc, /for \(const key of SUBJECT_STORAGE_KEYS\) sessionStorage\.removeItem\(key\)/, 'clearClarkMemory removes subject keys')
assert.doesNotMatch(memorySrc, /sessionStorage\.removeItem\(SESSION_ID_KEY\)/, 'clearClarkMemory must not rotate/wipe the session id')
assert.match(memorySrc, /'chainlens:clark-session-id'/, 'stable session id key is unchanged')
assert.match(memorySrc, /'chainlens:clark:last-wallet'/, 'working-set wallet key remains shared across surfaces in the same chat')
assert.match(memorySrc, /'chainlens:clark:last-token'/, 'working-set token key remains shared across surfaces in the same chat')
assert.match(memorySrc, /missing\?: 'keep' \| 'clear'/, 'switching chats can clear when the target chat has no snapshot')
assert.match(memorySrc, /if \(typeof chatId === 'string' && chatId\.trim\(\)\) saveClarkMemoryForChat\(chatId\)/, 'memoryEcho still snapshots the current chat after a response')

assert.match(pageSrc, /clearClarkMemory, saveClarkMemoryForChat, loadClarkMemoryForChat, deleteClarkMemoryForChat/, 'clark-ai page imports the chat isolation helpers')
assert.match(pageSrc, /clearClarkMemory\(\)/, 'new chat clears subject memory')
assert.match(pageSrc, /saveClarkMemoryForChat\(prev\)/, 'leaving a chat snapshots its subject memory')
assert.match(pageSrc, /loadClarkMemoryForChat\(chatId, \{ missing: 'clear' \}\)/, 'switching chats cannot leak the previous subject')
assert.match(pageSrc, /loadClarkMemoryForChat\(chatId, \{ missing: 'keep' \}\)/, 'refreshing the same chat keeps in-progress memory')
assert.match(pageSrc, /deleteClarkMemoryForChat\(id\)/, 'deleting a chat drops its namespaced snapshot')
assert.match(pageSrc, /handleNewChat\(\{ ignoreLimit: true, skipSave: true \}\)/, 'deleting the active chat must not re-snapshot it')
assert.match(pageSrc, /persistClarkMemoryEcho\(payload, activeChatIdRef\.current\)/, 'same-chat replies still persist useful memory')
assert.match(pageSrc, /requestGateRef\.current\.bumpSession\(\)/, 'AbortController/request-gate lifecycle is unchanged')

console.log('test-clark-chat-memory-isolation.mjs: all assertions passed')
