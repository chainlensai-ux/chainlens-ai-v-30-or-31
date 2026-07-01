// MODULE — bridgeDetection: public entry point.
//
// Pure transform over already-normalized events — no provider calls, no side effects. Additive to
// the existing V2 pipeline: callers that don't invoke this module are entirely unaffected, and no
// existing module's output shape changes because this one exists.

import type { NormalizedEvent } from '../normalization/types'
import type { BridgeDetectionResult } from './types'
import { detectBridgeCandidates } from './utils'

export function buildBridgeDetectionObject(normalizedEvents: NormalizedEvent[]): BridgeDetectionResult {
  return { bridgeTimeline: detectBridgeCandidates(normalizedEvents) }
}

export type { BridgeCandidateEvent, BridgeConfidence, BridgeDetectionResult } from './types'
