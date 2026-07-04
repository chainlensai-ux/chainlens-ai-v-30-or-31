# worker/Dockerfile — always-on Node worker for the ChainLens Deep Scan (Railway deployment).
#
# DESIGN NOTE (see worker/README.md for the full disclosure): this builds from the REPO ROOT, not
# an isolated worker/ subfolder with its own node_modules. The real scan pipeline this worker calls
# (src/deployment, src/pipeline, src/modules/*, lib/engines/*) depends on this repo's existing,
# already-pinned dependency tree (GoldRush SDK, viem, @vercel/kv, etc.) — maintaining a SECOND,
# separate package.json/node_modules for just the worker would risk silently drifting from those
# versions over time. Reusing the one real, existing package.json/package-lock.json avoids that
# risk entirely, at the cost of a slightly larger image (it does include Next.js itself, unused by
# the worker at runtime, but not modified or duplicated to avoid it).

FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies first (better layer caching on rebuilds when only source changes).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Now copy the rest of the real repo — the worker imports directly from src/deployment, which in
# turn pulls in src/pipeline, src/modules/*, lib/engines/*, lib/providers/*, lib/server/*.
COPY . .

ENV NODE_ENV=production

# Railway sets PORT itself; worker/server.ts already reads process.env.PORT with an 8080 fallback.
EXPOSE 8080

# Runs the TypeScript source directly via tsx (no separate compile step) — same tool already used
# elsewhere in this repo's own tooling (see package.json's "worker" script, identical command).
CMD ["npx", "tsx", "worker/server.ts"]
