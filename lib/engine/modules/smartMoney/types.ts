// lib/engine/modules/smartMoney/types.ts — shared types for the new Smart Money Score module.
//
// FILE-LOCATION DISCLOSURE: the task said `src/pipeline/src/types/smartMoneyScore.ts` — no
// `src/pipeline/src/` directory exists anywhere in this codebase (the real pipeline is
// `src/pipeline/index.ts`, flat, no `src/`/`types`/`modules`/`engine` subtree under it). Co-located
// here instead, under `lib/engine/modules/smartMoney/`, matching this session's own established
// convention for every other additive V2 module (holdings, pricing, portfolio, pnl, activity, risk,
// personality, behavior, signals all live at `lib/engine/modules/<name>/`).
//
// SHAPES, EXACTLY AS SPECIFIED (no changes) — SmartMoneyScoreComponents/SmartMoneyScore match the
// task's literal request.

export type SmartMoneyScoreComponents = {
  pnlScore: number
  behaviorScore: number
  personalityScore: number
  chainActivityScore: number
  riskScore: number
  signalsScore: number
}

export type SmartMoneyScore = {
  score: number // 0-100
  components: SmartMoneyScoreComponents
  notes: string[]
}
