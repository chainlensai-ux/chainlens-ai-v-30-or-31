# Holder API env/runtime verification (2026-05-21)

## Scope
- No holder logic changed.
- No UI changed.
- Verification only.

## What was verified

### Local / Development
- `.env.local` present: **false**
- `GOLDRUSH_API_KEY`: **hasKey=false**, length bucket: **0**
- `COVALENT_API_KEY`: **hasKey=false**, length bucket: **0**

Result: local/dev is missing holder provider key(s), so runtime will report no API key.

### Production / Preview (Vercel)
- Could not be directly queried from this container because the Vercel CLI is not installed here.
- Deployed env status is therefore **not verifiable from this runtime** without either:
  - Vercel project env access (dashboard/CLI), or
  - calling deployed `/api/token?...&debug=true` URL for both production and preview deployments.

## Runtime debug contract to check
Use `/api/token?contract=<token-address>&debug=true` and inspect `_debug.holderDiagnostics`:
- `hasApiKey` should be `true`
- `attempted` should be `true`

If `hasApiKey=false`, verify env names exactly:
- `GOLDRUSH_API_KEY`
- `COVALENT_API_KEY`

## Exact fix steps

1. Add holder key in the correct environment(s):
   - Local: add `GOLDRUSH_API_KEY=...` in `.env.local`
   - Vercel: set `GOLDRUSH_API_KEY` for **Production** and **Preview** (and Development if used)
2. Ensure key name has no typo/spacing and is exact.
3. Restart runtime after changes:
   - Local: restart `next dev`
   - Vercel: redeploy the target environment(s)
4. Re-verify with debug endpoint:
   - Confirm `_debug.holderDiagnostics.hasApiKey === true`
   - Confirm `_debug.holderDiagnostics.attempted === true`

