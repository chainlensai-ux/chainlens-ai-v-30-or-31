# Memory — Client-Side Session State

**Source:** `lib/client/clarkMemory.ts`

## sessionStorage keys

| Key | Purpose |
|---|---|
| `chainlens:clark-session-id` | Stable session ID, generated once, never regenerated per message |
| `chainlens:clark:last-wallet` | Last scanned wallet snapshot |
| `chainlens:clark:recent-wallets` | List of recently scanned wallets |
| `chainlens:clark:last-token` | Last scanned token evidence |
| `chainlens:clark:recent-tokens` | List of recently scanned tokens |
| `chainlens:clark:last-momentum-list` | Last Base market-movers list shown |
| `chainlens:clark:last-momentum-shown-count` | How many movers were already shown (for "show me more") |

## localStorage keys

| Key | Purpose |
|---|---|
| `chainlens:lastMarketMomentum` | Market momentum cache, 15-minute TTL |

## Key functions

- `getClarkSessionId()` — creates/retrieves the stable per-browser-session ID
- `readClarkClientContext()` — loads all memory from sessionStorage for the current turn
- `persistClarkMemoryEcho()` — saves server-returned wallet/token memory back to the client
- `persistClarkMomentumList()` — saves the Base movers list
- `readMarketMomentum()` — reads and validates the 15-minute market cache

## Relationship to server memory

Client memory is a cache/echo of what the server already computed — it lets the UI restore context (e.g. "last token") on reload without re-querying the server. The authoritative memory for follow-up routing is server-side — see [[Session-Memory-Server]].
