import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// ─── RPC ──────────────────────────────────────────────────────────────────────
// Read-only eth_getCode call. No transactions, no wallet interaction.

async function getContractCode(address: string): Promise<string | null> {
  const key = process.env.ALCHEMY_BASE_KEY ?? "";
  const rpc = key
    ? `https://base-mainnet.g.alchemy.com/v2/${key}`
    : "https://mainnet.base.org";

  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [address, "latest"],
    }),
    cache: "no-store",
  });

  if (!res.ok) return null;
  const json = await res.json();
  const code: string = json?.result ?? "";
  if (code === "0x" || code === "") return null;
  return code.toLowerCase().replace(/^0x/, "");
}

// ─── Selector library ─────────────────────────────────────────────────────────
// 4-byte function selectors (keccak256 of ABI signature, first 4 bytes, hex).

const SEL = {
  // Proxy / upgradeable
  upgradeTo:                "3659cfe6", // upgradeTo(address)
  upgradeToAndCall:         "4f1ef286", // upgradeToAndCall(address,bytes)
  implementation:           "5c60da1b", // implementation()
  // Router (Uniswap V2/V3 + Aerodrome/Velodrome on Base)
  swapExactTokensForTokens: "38ed1739",
  swapTokensForExactTokens: "8803dbee",
  addLiquidity:             "e8e33700",
  addLiquidityETH:          "f305d719",
  removeLiquidity:          "baa2abde",
  exactInputSingle:         "414bf389", // Uni V3
  exactInput:               "c04b8d59",
  exactOutputSingle:        "db3e2198",
  // LP manager (Uni V3 NonfungiblePositionManager)
  mintLP:                   "88316456", // mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))
  decreaseLiquidity:        "0c49ccbe",
  collect:                  "fc6f7865",
  // Locker patterns
  lockTokens:               "dd467064", // lock(uint256)
  extendLock:               "4bb278f3", // extendLock(uint256,uint256)
  unlock:                   "a69df4b5", // unlock()
  // Withdraw / rescue / sweep / skim
  withdraw:                 "3ccfd60b", // withdraw()
  withdrawTo:               "205c2878", // withdrawTo(address,uint256)
  withdrawToken:            "01e33667", // withdrawToken(address,uint256)
  sweep:                    "e8078d94", // sweep(address,address,uint256)
  sweepToken:               "df2ab5bb", // sweepToken(address,uint256,address)
  skim:                     "bc25cf77", // skim(address)
  claim:                    "4e71d92d", // claim()
  claimTokens:              "df8de3e7", // claimTokens(address,address[])
  rescue:                   "59d0f713", // rescue(address,uint256)
  rescueETH:                "8cd4426d", // rescueETH()
  rescueToken:              "69df1d37", // rescueToken(address,address,uint256)
  emergencyWithdraw:        "db2e21bc", // emergencyWithdraw()
  // Mint / Burn
  mint:                     "40c10f19", // mint(address,uint256)
  mintTo:                   "449a52f8", // mintTo(address,uint256)
  burn:                     "42966c68", // burn(uint256)
  burnFrom:                 "79cc6790", // burnFrom(address,uint256)
  // Fee / Tax setters (common rug vectors)
  setFee:                   "8b4cee08", // setFee(uint256)
  setTax:                   "77359751", // setTax(uint256)
  setBuyTax:                "a5ece941",
  setSellTax:               "f7c618c1",
  // External call patterns (call(), delegatecall())
  execute:                  "1cff79cd", // execute(address,bytes)
  multicall:                "ac9650d8", // multicall(bytes[])
} as const;

// ─── EIP-1167 Minimal Proxy detection ────────────────────────────────────────
// Runtime bytecode of a minimal proxy starts with this prefix.
const MINIMAL_PROXY_PREFIX = "363d3d373d3d3d363d73";
const MINIMAL_PROXY_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

// ─── Analysis ─────────────────────────────────────────────────────────────────

function containsSelector(bytecode: string, selector: string): boolean {
  return bytecode.includes(selector);
}

function analyzeContract(bytecode: string) {
  const has = (sel: string) => containsSelector(bytecode, sel);

  // Proxy: minimal proxy OR contains implementation() + delegatecall opcode (f4)
  const isMinimalProxy =
    bytecode.startsWith(MINIMAL_PROXY_PREFIX) &&
    bytecode.endsWith(MINIMAL_PROXY_SUFFIX);

  const hasImplementationSlot = has(SEL.implementation);
  // delegatecall opcode = f4; present in most proxy contracts
  const hasDelegatecall = bytecode.includes("f4");

  const is_proxy = isMinimalProxy || (hasImplementationSlot && hasDelegatecall);

  const is_upgradeable =
    has(SEL.upgradeTo) || has(SEL.upgradeToAndCall);

  const is_router =
    has(SEL.swapExactTokensForTokens) ||
    has(SEL.swapTokensForExactTokens) ||
    has(SEL.addLiquidity) ||
    has(SEL.addLiquidityETH) ||
    has(SEL.exactInputSingle) ||
    has(SEL.exactInput) ||
    has(SEL.exactOutputSingle);

  const is_locker =
    has(SEL.lockTokens) ||
    has(SEL.extendLock) ||
    (has(SEL.unlock) && !is_router);

  const is_lp_manager =
    has(SEL.mintLP) ||
    has(SEL.decreaseLiquidity) ||
    has(SEL.collect) ||
    (has(SEL.addLiquidity) && has(SEL.removeLiquidity) && !is_router);

  const has_withdraw =
    has(SEL.withdraw) ||
    has(SEL.withdrawTo) ||
    has(SEL.withdrawToken) ||
    has(SEL.emergencyWithdraw);

  const has_sweep =
    has(SEL.sweep) ||
    has(SEL.sweepToken) ||
    has(SEL.skim);

  const has_mint =
    has(SEL.mint) || has(SEL.mintTo);

  const has_burn =
    has(SEL.burn) || has(SEL.burnFrom);

  const has_rescue =
    has(SEL.claim) ||
    has(SEL.claimTokens) ||
    has(SEL.rescue) ||
    has(SEL.rescueETH) ||
    has(SEL.rescueToken);

  const has_external_calls =
    has(SEL.execute) || has(SEL.multicall);

  return {
    is_proxy,
    is_upgradeable,
    is_router,
    is_locker,
    is_lp_manager,
    has_withdraw,
    has_sweep,
    has_mint,
    has_burn,
    has_rescue,
    has_external_calls,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address")?.trim();

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json(
      { ok: false, error: "Invalid or missing address parameter." },
      { status: 400 }
    );
  }

  try {
    const bytecode = await getContractCode(address);

    if (!bytecode) {
      return NextResponse.json({
        ok: true,
        data: {
          is_proxy: false,
          is_upgradeable: false,
          is_router: false,
          is_locker: false,
          is_lp_manager: false,
          has_withdraw: false,
          has_sweep: false,
          has_mint: false,
          has_burn: false,
          has_rescue: false,
          has_external_calls: false,
          note: "EOA or undeployed address — no bytecode.",
        },
      });
    }

    return NextResponse.json({ ok: true, data: analyzeContract(bytecode) });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Contract analysis failed." },
      { status: 500 }
    );
  }
}
