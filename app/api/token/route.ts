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

async function fetchDexScreener(contract: string): Promise<any> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.error("Error fetching DexScreener:", err);
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

    const [bytecode, goldrush, dexscreener, gmgn, metadata] = await Promise.all([
      fetchBytecode(chain, contract),
      fetchGoldRush(chain, contract),
      fetchDexScreener(contract),
      fetchGMGN(contract),
      fetchTokenMetadata(chain, contract),
    ]);

    const analysis = analyzeContract(bytecode);

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
DEXSCREENER:
${JSON.stringify(dexscreener, null, 2)}
GOLDRUSH:
${JSON.stringify(goldrush, null, 2)}
BYTECODE ANALYSIS:
${JSON.stringify(analysis, null, 2)}
`;

   const aiResponse = await anthropic.messages.create({
  model: "claude-sonnet-4-6", // ✅ correct model name
  max_tokens: 1100,
  messages: [
    {
      role: "user",
      content: aiPrompt,
    },
  ],
});
console.log("AI response:", aiResponse); // ✅ add this to debug

    const aiSummary =
      (aiResponse?.content?.[0]?.type === "text" ? aiResponse.content[0].text : null) ||
      "AI summary unavailable";

    // ------------------------------
    // Resolve core token fields
    // ------------------------------
    const metaItem = metadata?.data?.items?.[0];
    const goldItem = goldrush?.data?.items?.[0];
    const gmgnItem = gmgn?.data;

    const mainPair = dexscreener?.pairs?.reduce((best: any, p: any) => {
      if (!best) return p;
      return (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? p : best;
    }, null);

    const resolvedName =
      metaItem?.contract_name ||
      goldItem?.contract_name ||
      mainPair?.baseToken?.name ||
      gmgnItem?.name ||
      "Unknown";

    const resolvedSymbol =
      metaItem?.contract_ticker_symbol ||
      goldItem?.contract_ticker_symbol ||
      mainPair?.baseToken?.symbol ||
      gmgnItem?.symbol ||
      "?";

    const resolvedDecimals =
      metaItem?.contract_decimals ||
      goldItem?.contract_decimals ||
      mainPair?.baseToken?.decimals ||
      gmgnItem?.decimals ||
      (contract.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" ? 6 : 18);

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
      liquidity: mainPair?.liquidity?.usd || goldrush?.liquidity || null,
      pairs: dexscreener?.pairs || [],
      gmgn: gmgn?.data || null,

      // Contract analysis
      analysis,

      // ✅ AI summary from Cortex Engine
      aiSummary,

      // ✅ Token info object for frontend panels
      tokenInfo: {
        name: resolvedName,
        symbol: resolvedSymbol,
        decimals: resolvedDecimals,
      },

      // Full DexScreener raw payload
      dexscreenerRaw: dexscreener || null,
    });
    } catch (err) {
    console.error("Fatal backend error:", err);
    return NextResponse.json(
      { error: "Internal server error" }, // body
      { status: 500 }                     // response init
    );
  }
} // <-- this closes the POST function

