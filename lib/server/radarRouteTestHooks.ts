type RadarResilienceResetOptions = { keepBackoff?: boolean; keepLastVerified?: boolean }
type RadarResilienceReset = (opts?: RadarResilienceResetOptions) => void

let resetImpl: RadarResilienceReset | null = null

/** Called once when the radar route module loads. Not a route export. */
export function registerRadarResilienceResetForTest(fn: RadarResilienceReset) {
  resetImpl = fn
}

export function __resetRadarResilienceStateForTest(opts: RadarResilienceResetOptions = {}): void {
  if (!resetImpl) throw new Error('radar route module has not been loaded')
  resetImpl(opts)
}
