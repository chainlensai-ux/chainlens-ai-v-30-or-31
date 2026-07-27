// MODULE — receiptSwapDecoder: canonical event topic0 hashes.
//
// Each hash is keccak256 of its exact Solidity event signature string. Verified against real ABI
// definitions from each protocol's own repository (aerodrome-finance/contracts for Classic pools —
// same Swap/Mint/Burn signature as the canonical Uniswap V2 pair; aerodrome-finance/slipstream's
// ICLPool for Slipstream — same Swap/Mint/Burn signature as canonical Uniswap V3 pools). Hashes are
// self-verified at test time (signatures.test.ts recomputes each via viem's own keccak256/toBytes
// and asserts equality against the constants below) so a transcription mistake here fails loudly
// rather than silently mis-decoding logs.

// Aerodrome Classic pool (Solidly/Uniswap-V2-style constant-product AMM):
//   Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)
export const CLASSIC_SWAP_TOPIC0 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
//   Mint(address indexed sender, uint256 amount0, uint256 amount1)
export const CLASSIC_MINT_TOPIC0 = '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f'
//   Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)
export const CLASSIC_BURN_TOPIC0 = '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496'

// Aerodrome Slipstream pool (Uniswap-V3-style concentrated-liquidity AMM):
//   Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
export const SLIPSTREAM_SWAP_TOPIC0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
//   Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
export const SLIPSTREAM_MINT_TOPIC0 = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
//   Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
// (signature hash below computed against the unindexed type list, which is all keccak256 of an
// event signature ever uses — indexed/unindexed placement never changes the topic0 hash itself)
export const SLIPSTREAM_BURN_TOPIC0 = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'

// Standard ERC20 Transfer(address indexed from, address indexed to, uint256 value) — used for the
// net-legs pass, wrap/unwrap detection, and refund detection alongside the pool-specific events
// above.
export const ERC20_TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// WETH9 Deposit(address indexed dst, uint256 wad) / Withdrawal(address indexed src, uint256 wad) —
// the two events emitted by Base's canonical WETH contract on native-ETH wrap/unwrap, used to
// recognize an ETH<->WETH leg as part of the same economic swap rather than a separate transfer.
export const WETH_DEPOSIT_TOPIC0 = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'
export const WETH_WITHDRAWAL_TOPIC0 = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'

export const WETH_BASE_ADDRESS = '0x4200000000000000000000000000000000000006'
