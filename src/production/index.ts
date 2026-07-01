// PRODUCTION HARDENING — index
//
// Combines logger / metrics / errorReporter / tracing / providerCallTracker / health into a
// single exported object. This file (and everything it re-exports) is purely additive
// observability: none of it modifies, wraps, or is imported BY any file under src/modules or
// src/pipeline. It exists to be optionally used BY a caller of runWalletScan(), never the reverse.

import * as logger from './logger'
import * as metrics from './metrics'
import * as errorReporter from './errorReporter'
import * as tracing from './tracing'
import * as providerCallTracker from './providerCallTracker'
import * as health from './health'

export { logger, metrics, errorReporter, tracing, providerCallTracker, health }

export default {
  logger,
  metrics,
  errorReporter,
  tracing,
  providerCallTracker,
  health,
}
