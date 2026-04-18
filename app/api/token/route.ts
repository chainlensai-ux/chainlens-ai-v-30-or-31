import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CHAIN_RPC_MAP = {
  eth: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETHEREUM_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}`,
  polygon: `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POLYGON_KEY}`,
  bnb: `https://bnb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BNB_KEY}`,
} as const;

type ChainKey = keyof typeof CHAIN_RPC_MAP;

// ------------------------------
// Fetch helpers
// ------------------------------
async function fetchBytecode(chain: ChainKey, contract: string): Promise<string | null> {
  try {
    const rpcUrl = CHAIN_RPC_MAP[chain];
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [contract, "latest"],
      }),
    });
    const json = await res.json();
    return json?.result || null;
  } catch (err) {
    console.error(`Error fetching bytecode on ${chain}:`, err);
    return null;
  }
}

async function fetchGoldRush(chain: ChainKey, contract: string): Promise<any> {
  try {
    const res = await fetch(
      `https://api.covalenthq.com/v1/${chain}/tokens/${contract}/?key=${process.env.COVALENT_API_KEY}`
    );
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.error("Error fetching GoldRush:", err);
    return null;
  }
}

async function fetchGeckoTerminal(contract: string, chain: ChainKey): Promise<any> {
  try {
    const network = chain === "ethereum" ? "eth" : "base";
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "";
    const res = await fetch(`${baseUrl}/api/proxy/gt?network=${network}`, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.error("Error fetching GeckoTerminal:", err);
    return null;
  }
}

async function fetchGMGN(contract: string): Promise<any> {
  try {
    const res = await fetch(`https://api.gmgn.ai/token/${contract}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fetchTokenMetadata(chain: ChainKey, contract: string): Promise<any> {
  try {
    const res = await fetch(
      `https://api.covalenthq.com/v1/${chain}/address/0x0000000000000000000000000000000000000000/balances_v2/?key=${process.env.COVALENT_API_KEY}&contract-address=${contract}`
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ------------------------------
// Detect chain
// ------------------------------
async function detectChain(contract: string): Promise<ChainKey | null> {
  for (const [chainKey, rpcUrl] of Object.entries(CHAIN_RPC_MAP)) {
    try {
      const rpcRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getCode",
          params: [contract, "latest"],
        }),
      });
      const json = await rpcRes.json();
      if (json?.result && json.result !== "0x") {
        console.log(`✅ Chain detected: ${chainKey}`);
        return chainKey as ChainKey;
      }
    } catch (err) {
      console.error(`RPC error on ${chainKey}:`, err);
    }
  }
  return null;
}

// ------------------------------
// Contract analysis
// ------------------------------
function analyzeContract(bytecode: string | null): any {
  const suspicious: string[] = [];

  if (!bytecode || bytecode === "0x") {
    return {
      ownerStatus: "Owner status not fully analyzed",
      liquidityStatus: "No liquidity lock patterns detected",
      honeypot: "No obvious honeypot pattern detected",
      suspiciousFunctions: suspicious,
    };
  }

  if (bytecode.includes("selfdestruct") || bytecode.includes("suicide")) {
    suspicious.push("selfdestruct");
  }

  return {
    ownerStatus: "Owner status not fully analyzed",
    liquidityStatus: "No liquidity lock patterns detected",
    honeypot: "No obvious honeypot pattern detected",
    suspiciousFunctions: suspicious,
  };
}

// ------------------------------
// POST handler
// ------------------------------
export async function POST(req: Request) {
  try {
    console.log("🚀 SCAN ROUTE HIT");

    const { contract } = await req.json();

    if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return NextResponse.json({ error: "Invalid contract address" }, { status: 400 });
    }

    console.log("Incoming scan request:", contract);

    const chain = await detectChain(contract);
    if (!chain) {
      return NextResponse.json({ error: "Could not detect chain" }, { status: 400 });
    }

    const [bytecode, goldrush, gtData, gmgn, metadata] = await Promise.all([
      fetchBytecode(chain, contract),
      fetchGoldRush(chain, contract),
      fetchGeckoTerminal(contract, chain),
      fetchGMGN(contract),
      fetchTokenMetadata(chain, contract),
    ]);

    const analysis = analyzeContract(bytecode);

    // Match GT pools to this contract via included[] token entries
    const gtIncluded: any[] = Array.isArray(gtData?.included) ? gtData.included : [];
    const gtAllPools: any[] = Array.isArray(gtData?.data) ? gtData.data : [];

    const matchingTokenEntry = gtIncluded.find((i: any) =>
      i.attributes?.address?.toLowerCase() === contract.toLowerCase()
    );
    const matchingTokenId = matchingTokenEntry?.id;

    const matchingPools = matchingTokenId
      ? gtAllPools.filter((p: any) => p.relationships?.base_token?.data?.id === matchingTokenId)
      : gtAllPools;

    const mainPool = [...matchingPools].sort(
      (a, b) =>
        parseFloat(b.attributes?.reserve_in_usd || "0") -
        parseFloat(a.attributes?.reserve_in_usd || "0")
    )[0] ?? null;

    const analysis2 = analyzeContract(bytecode);

    // ------------------------------
    // REAL CLAUDE AI SUMMARY
    // ------------------------------
    const aiPrompt = `
You are the Cortex Engine of ChainLens AI.
Summarize this token in 3–4 sentences.
Focus on risks, liquidity, ownership, and suspicious functions.
Output plain text only, no markdown, no tables.

CHAIN: ${chain}
CONTRACT: ${contract}
GECKOTERMINAL POOLS:
${JSON.stringify(matchingPools.slice(0, 3), null, 2)}
GOLDRUSH:
${JSON.stringify(goldrush, null, 2)}
BYTECODE ANALYSIS:
${JSON.stringify(analysis2, null, 2)}
`;

    const aiResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1100,
      messages: [{ role: "user", content: aiPrompt }],
    });
    console.log("AI response:", aiResponse);

    const aiSummary =
      (aiResponse?.content?.[0]?.type === "text" ? aiResponse.content[0].text : null) ||
      "AI summary unavailable";

    // ------------------------------
    // Resolve core token fields
    // ------------------------------
    const metaItem = metadata?.data?.items?.[0];
    const goldItem = goldrush?.data?.items?.[0];
    const gmgnItem = gmgn?.data;

    const resolvedName =
      metaItem?.contract_name ||
      goldItem?.contract_name ||
      matchingTokenEntry?.attributes?.name ||
      gmgnItem?.name ||
      "Unknown";

    const resolvedSymbol =
      metaItem?.contract_ticker_symbol ||
      goldItem?.contract_ticker_symbol ||
      matchingTokenEntry?.attributes?.symbol ||
      gmgnItem?.symbol ||
      "?";

    const resolvedDecimals =
      metaItem?.contract_decimals ||
      goldItem?.contract_decimals ||
      gmgnItem?.decimals ||
      18;

    // ------------------------------
    // Final JSON response
    // ------------------------------
    return NextResponse.json({
      chain,
      contract,

      // Core token fields
      name: resolvedName,
      symbol: resolvedSymbol,
      decimals: resolvedDecimals,

      // Extra data
      holders: goldrush?.holders || null,
      liquidity: mainPool?.attributes?.reserve_in_usd || goldrush?.liquidity || null,

      // GT pools replacing DexScreener pairs
      pairs: matchingPools,
      gtPools: matchingPools,
      gtRaw: gtData || null,

      gmgn: gmgn?.data || null,

      // Contract analysis
      analysis,

      // AI summary from Cortex Engine
      aiSummary,

      // Token info object for frontend panels
      tokenInfo: {
        name: resolvedName,
        symbol: resolvedSymbol,
        decimals: resolvedDecimals,
      },
    });
  } catch (err) {
    console.error("Fatal backend error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
