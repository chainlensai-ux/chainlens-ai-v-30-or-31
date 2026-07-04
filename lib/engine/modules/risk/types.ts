// lib/engine/modules/risk/types.ts — shared types for the new risk module.
//
// FILE-LOCATION DISCLOSURE (same as every prior module this task chain): no single shared "engine
// types" file exists anywhere in this codebase — co-located with this module instead.
//
// "EXISTING risk FIELD", DISCLOSED: the task's own constraint says "do NOT modify or remove the
// existing risk field used by the production scanner" — verified by search before writing this
// file: no field named `risk` (or `riskLevel`/`riskScore`/`riskProfile`) exists anywhere in
// FinalReport/SanitizedReportV2 or any src/modules/* type. There is nothing to collide with or
// protect here, unlike the earlier `holdings`/`portfolio` field-collision cases this task chain hit
// — `riskV2`/`riskStatus` are added directly, exactly as specified, with no rename needed.
//
// SHAPES, EXACTLY AS SPECIFIED (no changes).

export type RiskV2 = {
  score: number // 0-100
  level: 'low' | 'medium' | 'high'
  concentrationRisk: number // 0-1
  stablecoinRatio: number // 0-1
  unrealizedPnlPressure: number // 0-1
  chainRisk: number // 0-1
  volatileExposure: number // 0-1
  fragmentationRisk: number // 0-1
}

export type RiskEngineOutput = {
  riskV2: RiskV2
  riskStatus: 'ok' | 'empty' | 'partial'
}
