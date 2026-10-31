/**
 * Maps a stored scan_memory.signal_json to the recorded check outcomes the CORTEX history API returns.
 * Only the enumerated check outcomes leave the server; the rest of the stored signal (risk inputs, hashes) does not.
 */
const STATUS = /^[a-z_]{1,32}$/
const status = (v: unknown) => (typeof v === 'string' && STATUS.test(v) ? v : null)
export function recordedFactors(signal: unknown) {
  if (!signal || typeof signal !== 'object') return null
  const s = signal as { contract_flags?: Record<string, unknown>; honeypot?: { is_honeypot?: unknown }; lp_status?: unknown; dev_status?: unknown }
  const flags: Record<string, unknown> = s.contract_flags && typeof s.contract_flags === 'object' ? s.contract_flags : {}
  const honeypot = s.honeypot?.is_honeypot
  return {
    honeypot: honeypot === true ? true : honeypot === false ? false : null,
    mint: status(flags.mint),
    blacklist: status(flags.blacklist),
    pause: status(flags.pause),
    lpStatus: status(s.lp_status),
    devStatus: status(s.dev_status),
  }
}

