// PRODUCTION HARDENING — logger
//
// Purely additive, structured logging for the 180-day intelligence engine. This module has NO
// dependency on, and makes NO change to, any file under src/modules or src/pipeline — it is an
// optional instrumentation layer a caller can invoke around those modules, never a modification
// of them. No provider calls, no pipeline behavior changes.
//
// Never leaks sensitive data: wallet addresses are masked before being logged (only the first 6
// and last 4 characters are shown), and callers are expected to route error text through
// errorReporter.sanitizeError() before logging it here.

export type LogEntry = {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

const logBuffer: LogEntry[] = []

function record(level: LogEntry['level'], message: string): void {
  const entry: LogEntry = { timestamp: new Date().toISOString(), level, message }
  logBuffer.push(entry)
  const line = `[${entry.timestamp}] [${level.toUpperCase()}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

// Masks a wallet address for safe logging — never logs the full address verbatim.
export function maskAddress(address: string): string {
  if (typeof address !== 'string' || address.length < 10) return '0x***'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function logStageStart(stageName: string): void {
  record('info', `stage started: ${stageName}`)
}

export function logStageEnd(stageName: string): void {
  record('info', `stage completed: ${stageName}`)
}

export function logWarning(message: string): void {
  record('warn', message)
}

export function logError(message: string): void {
  record('error', message)
}

export function logChainStatus(chain: string, providerStatus: string): void {
  record('info', `chain=${chain} providerStatus=${providerStatus}`)
}

export function logFallback(sectionName: string): void {
  record('warn', `fallback engaged: ${sectionName}`)
}

// Additive convenience export — not part of the literal spec, but needed for any consumer (e.g.
// health.ts's buildHealthSummary, or an external caller) that wants to inspect what was logged
// during a run without depending on console output. Returns a shallow copy; the internal buffer
// itself is never exposed for external mutation.
export function getLogBuffer(): LogEntry[] {
  return [...logBuffer]
}

export function clearLogBuffer(): void {
  logBuffer.length = 0
}
