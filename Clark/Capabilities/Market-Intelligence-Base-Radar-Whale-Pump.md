# Capability — Market Intelligence (Base Radar, Whale Alerts, Pump/Movers)

**Tool name:** `market_get_base_movers`
**Handlers:** `scanBaseRadarData()`, `scanWhaleData()`, `scanPumpData()` in `app/api/clark/route.ts`

## Base Radar

`scanBaseRadarData()` fetches a Base Radar snapshot via `/api/base-radar`. Routed when the prompt contains "radar" (intent `base_radar` in `classifyClarkPrompt()`).

## Base Market Discovery / Movers

`scanPumpData()` / the Base-movers handler surfaces trending/pumping Base tokens. Routed by `base_market_discovery` intent: "what's pumping on base", "trending tokens", "base movers", etc.

Results are cached client-side for 15 minutes (`chainlens:lastMarketMomentum`, see [[Session-Memory-Client]]) and persisted into session memory as `lastMomentumList` so follow-up questions ("show me more", "any of those riskier?") can reference the same list without re-fetching.

## Whale Alerts

`scanWhaleData()` analyzes the whale/smart-money feed. Routed by `whale_alert` intent: "whales", "whale alerts", "big wallet", "smart money". Output format follows the Whale Signal template in [[Output-Formats]] — signal, why it matters, confidence, what to verify. Clark is explicitly banned from claiming "whales are buying" without a live whale-feed result backing it.

## Output discipline

None of these surfaces are allowed to imply certainty about future price action — they report observed on-chain activity only, framed with confidence and "what to verify" per [[Evidence-Honesty-Patterns]].
