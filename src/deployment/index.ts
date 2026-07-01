// DEPLOYMENT LAYER — index
//
// Combines env / validator / rateLimiter / router / api into a single exported object. This
// layer exposes runWalletScan() as a production-ready request handler without modifying any
// existing module — router.ts is the only file that imports runWalletScan, and it does so
// exactly as any other caller would (no special access, no bypass of validation/fallback logic).

import * as env from './env'
import * as validator from './validator'
import * as rateLimiter from './rateLimiter'
import * as router from './router'
import * as api from './api'

export { env, validator, rateLimiter, router, api }

export default {
  env,
  validator,
  rateLimiter,
  router,
  api,
}
