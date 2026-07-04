# ChainLens full-scan worker (Railway)

An always-on Node/Express service that runs the exact same Wallet Scanner V2 unified scan
(`router.handleScanRequest`) every Vercel route already uses — outside Vercel's serverless model, so
a Deep Scan is never subject to a 60-second function-invocation ceiling or a per-request cold start.

**This is additive.** It does not replace, modify, or remove any existing Vercel route
(`/api/scan`, `/api/scan-v2/*`, `/api/scan-v2/full-scan`, etc.), any `src/modules/*` file, `src/
pipeline/*`, or the `FinalReport` type. The frontend still calls the Vercel routes today — pointing
it at this worker instead is a separate, deliberate decision not made here (out of scope: "do not
modify frontend UI components").

## What's here

- `worker/server.ts` — the Express app. One real route: `POST /full-scan`. Also `GET /health` for
  Railway's healthcheck.
- `worker/Dockerfile` — builds from the **repo root** (see "Why build from the repo root" below).
- `railway.json` (repo root) — points Railway's Dockerfile build at `worker/Dockerfile`.
- Two small, disclosed additions to the repo's root `package.json`: `express`, `tsx` (runtime deps
  needed to run this file), and `@types/express` (dev-only, for editor/tsc correctness). A `worker`
  npm script (`tsx worker/server.ts`) was also added for local runs. Nothing else in `package.json`
  changed.

## Why build from the repo root (not an isolated `worker/` package)

The real scan pipeline this worker calls (`src/deployment`, `src/pipeline`, every `src/modules/*`,
`lib/engines/*`, `lib/providers/*`) depends on this repo's existing, already-pinned dependency tree
— GoldRush SDK, viem, `@vercel/kv`, etc. Giving the worker its own separate `package.json`/
`node_modules` would mean maintaining a second copy of those same dependencies, with a real risk of
silently drifting out of sync with the versions the rest of the app actually uses and is tested
against. Reusing the one real `package.json`/`package-lock.json` avoids that risk entirely. The
tradeoff: the built image includes Next.js itself, which this worker doesn't use at runtime — not
modified or trimmed here, since doing so would mean touching the shared root `package.json` in a
more invasive way than the two additions above.

## Environment variables

Exactly the same real env vars every Vercel route already reads at runtime (`GOLDRUSH_API_KEY`,
`ALCHEMY_BASE_KEY` / `ALCHEMY_ETHEREUM_KEY` / `ALCHEMY_ARBITRUM_KEY` and their fallback names,
`COINGECKO_API_KEY`, `KV_REST_API_URL` / `KV_REST_API_TOKEN` if you want this worker's own KV-backed
caching to work, etc. — see `.env.example` at the repo root for the full, real list). Set these as
Railway environment variables on the service; nothing worker-specific needs to be added beyond what
already exists in `.env.example`.

## Deploying to Railway

1. Create a new Railway project (or a new service inside an existing project) from this GitHub repo.
2. Railway will detect `railway.json` at the repo root and use `worker/Dockerfile` to build — no
   manual build/start command configuration needed.
3. Set the same environment variables as your Vercel deployment (copy them from Vercel's project
   settings, or from `.env.example`, into Railway's service variables).
4. Deploy. Railway will call `GET /health` to confirm the service is up before routing traffic to it.
5. Test it directly once deployed:
   ```bash
   curl -X POST https://<your-railway-service>.up.railway.app/full-scan \
     -H "Content-Type: application/json" \
     -d '{"walletAddress":"0xYOUR_WALLET","chains":["base","eth"],"scanMode":"deep"}'
   ```
   Expect `{"success":true,"data":{...FinalReport...}}` or `{"success":false,"error":{...}}` —
   verified live in this session against a local (non-Railway) run of this exact server with the
   exact same wallet/chain shape; the response body matched the same `FinalReport` fields the
   existing Vercel routes return.

## Honest disclosures

- **Performance claim, corrected:** the task that produced this worker described cutting Deep Scan
  runtime "from ~60 seconds to ~10-15 seconds." That specific number isn't something this file can
  verify or promise — the real bottleneck in a Deep Scan is network round-trips to GoldRush/Alchemy/
  CoinGecko/on-chain RPC endpoints, which take exactly as long here as anywhere else. What genuinely
  changes: no per-request cold start (typically low single-digit seconds on Vercel, deployment-
  dependent), and no 60-second execution ceiling (a slow-but-legitimate Deep Scan can finish
  instead of being killed). Measure actual end-to-end latency against a real deployment rather than
  assuming a specific number.
- **A real bug was found and fixed during this session's own live verification**, before this file
  was ever committed: `express.json()`'s body-parser throws synchronously on a malformed request
  body, before Express ever reaches the `/full-scan` handler's own `try/catch` — which meant a
  malformed request originally fell through to Express's default HTML error page instead of this
  service's own `{success:false, error:{...}}` JSON contract. Fixed with an explicit Express
  error-handling middleware (see `server.ts`'s own comment on this) and re-verified live: a
  malformed body now correctly returns a structured JSON 400.
- **Not wired to the frontend.** Deploying this worker doesn't change any user-facing behavior by
  itself — the frontend's `scanWalletV2()` still calls the Vercel `/api/scan-v2/full-scan` route.
  Pointing it at this worker instead (via an env-configured base URL, presumably) is a follow-up
  decision, deliberately not made in this change.
