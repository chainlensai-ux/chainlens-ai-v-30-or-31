@AGENTS.md
# ChainLens AI — Claude Code Rules

ChainLens AI is a Base-native CORTEX intelligence terminal.

## Product direction

Do not build 8 random tools. Build 3 flagship engines:

1. Token Scanner = full token intelligence engine
2. Whale Alerts = live wallet movement engine
3. Base Radar = market discovery/opportunity engine

Clark/CORTEX explains everything.
Watchlist/rescan history makes users come back.

## Style

Premium dark crypto SaaS:
- black/navy base
- mint/teal/purple/pink accents
- glass cards
- sharp typography
- Nansen/Arkham/Glassnode-level
- no cheap debug-console look

## Public UI rules

Never show provider names publicly:
- CoinGecko
- DexScreener
- GoldRush
- Covalent
- Alchemy
- Zerion
- GoPlus

Use public wording:
- CORTEX Engine
- Market data
- Security intelligence
- Risk Checks
- Holder Map
- LP Control
- Dev Control
- Unverified
- Partial
- Watch

Never leak raw provider errors, API keys, RPC URLs, or internal diagnostics in public UI.

## Data honesty

Never fake:
- market cap
- holder concentration
- holder count
- wallet holdings
- PnL
- smart money labels
- LP lock/burn proof
- security/tax/honeypot status
- dev-linked wallets
- previous deployments

FDV must never be called market cap.
If market cap is missing, show “Market cap unverified” and show FDV separately.
If data is missing, show Unverified/Partial and explain what is missing.

## Implementation rules

For every task:
- Keep scope surgical
- Do not touch unrelated pages
- Do not refactor unless asked
- Do not scan the whole repo unless necessary
- Prefer small safe patches
- Preserve cache, rate limits, timeouts, safe fallbacks
- No provider spam
- No raw provider errors
- No API/RPC leaks
- Run npm run build
- Return root cause, files changed, tests, build result

## Current priorities

1. Fix Token Scanner score caps so low-cap/incomplete scans cannot show 100
2. Fix Holder Concentration end-to-end
3. Fix LP Control reliability and pool states
4. Upgrade Whale Alerts signal scoring/noise filtering
5. Add Dev Control inside Token Scanner
6. Add CORTEX Risk Checks
7. Build Watchlist + Change Since Last Scan
8. Upgrade Base Radar with Momentum Score + Why Moving
