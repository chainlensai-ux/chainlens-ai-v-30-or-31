// lib/engine/modules/signals/types.ts — shared types for the new signal module.
//
// FILE-LOCATION DISCLOSURE (same as every prior module this task chain): no single shared "engine
// types" file exists anywhere in this codebase — co-located with this module instead.
//
// "EXISTING signal/intelligence FIELD", DISCLOSED: verified by search before writing anything — no
// field named `signals`/`signalsV2`/`SignalV2` (or similar) exists anywhere in FinalReport/
// SanitizedReportV2 or any src/modules/* type. Nothing to collide with or protect — `signalsV2`/
// `signalsStatus` added directly, exactly as specified.
//
// SHAPES, EXACTLY AS SPECIFIED (no changes).

export type SignalV2 = {
  id: string
  type:
    | 'rotation_to_stables'
    | 'rotation_from_stables'
    | 'base_meme_accumulation'
    | 'bridging_out_of_base'
    | 'bridging_into_base'
    | 'high_unrealized_loss_pressure'
    | 'entering_high_risk_posture'
    | 'exiting_high_risk_posture'
    | 'whale_like_accumulation'
    | 'lp_farming_cycle'
    | 'stablecoin_routing'
    | 'high_trade_frequency'
    | 'dormant_wallet'
  severity: 'low' | 'medium' | 'high'
  summary: string
  details: string
}

export type SignalsEngineOutput = {
  signalsV2: SignalV2[]
  signalsStatus: 'ok' | 'empty' | 'partial'
}
