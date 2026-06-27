# Backend — RPC Chain Configuration

**Source:** `lib/server/lpProof.ts` (~lines 31–46)

## Resolution order per chain

**Ethereum:**
1. `ETH_RPC_URL` (explicit override)
2. Alchemy (`ALCHEMY_ETHEREUM_KEY`)
3. No fallback — if neither resolves, RPC-dependent proofs fail closed (reported as unverified, never assumed)

**Base:**
1. `BASE_RPC_URL` (explicit override)
2. `ALCHEMY_BASE_RPC_URL`
3. `ALCHEMY_BASE_KEY` (constructs Alchemy URL)
4. `https://mainnet.base.org` (public fallback RPC)

## Where this is used

Any capability that needs live on-chain reads — LP liquidity/slot0 probes, `ownerOf`/`positions` calls for concentrated-liquidity sampling, contract bytecode checks — goes through this resolution chain. See [[Liquidity-LP-Proof]].

## Why Base has a public fallback and Ethereum doesn't

Base RPC reads are core to ChainLens's primary use case (it's a Base-native terminal), so a public fallback exists to avoid total failure if no paid key is configured. Ethereum support is secondary, so no public fallback is configured — if no key resolves, Ethereum-chain proofs simply report as unverified rather than risking a flaky/rate-limited public endpoint.
