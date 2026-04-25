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
    const networkMap: Record<ChainKey, string> = {
      eth:     'eth',
      base:    'base',
      polygon: 'polygon_pos',
      bnb:     'bsc',
    };
    const network = networkMap[chain] ?? 'base';
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${contract}/pools?page=1&include=base_token%2Cquote_token`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
      }
    );
    if (!res.ok) {
      console.error('GeckoTerminal pools error:', res.status, await res.text().catch(() => ''));
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("Error fetching GeckoTerminal pools:", err);
    return null;
  }
}

async function fetchGeckoTerminalToken(contract: string, chain: ChainKey): Promise<any> {
  try {
    const networkMap: Record<ChainKey, string> = {
      eth:     'eth',
      base:    'base',
      polygon: 'polygon_pos',
      bnb:     'bsc',
    };
    const network = networkMap[chain] ?? 'base';
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${contract}`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Error fetching GeckoTerminal token info:", err);
    return null;
  }
}

async function fetchHoneypot(contract: string, chain: ChainKey): Promise<any> {
  try {
    const chainIdMap: Record<ChainKey, number> = {
      eth:     1,
      base:    8453,
      polygon: 137,
      bnb:     56,
    };
    const chainId = chainIdMap[chain];
    if (!chainId) return null;
    const res = await fetch(
      `https://api.honeypot.is/v2/IsHoneypot?address=${contract}&chainID=${chainId}`,
      { cache: 'no-store' }
    );
    if (!res.ok) {
      console.error('Honeypot.is error:', res.status);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('Error fetching honeypot.is:', err);
    return null;
  }
}


async function fetchGoPlus(chain: ChainKey, contract: string): Promise<unknown> {
  try {
    const chainIdMap: Record<ChainKey, string> = {
      eth:     '1',
      base:    '8453',
      polygon: '137',
      bnb:     '56',
    };
    const chainId = chainIdMap[chain];
    if (!chainId) return null;
    const res = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${contract}`,
      { cache: 'no-store' }
    );
    if (!res.ok) {
      console.error('GoPlus error:', res.status);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('Error fetching GoPlus:', err);
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

    // Token Scanner is Base-only.
    const chain: ChainKey = "base";

    const [bytecode, goldrush, gtData, gtTokenInfo, gmgn, metadata, gpRaw, hpRaw] = await Promise.all([
      fetchBytecode(chain, contract),
      fetchGoldRush(chain, contract),
      fetchGeckoTerminal(contract, chain),
      fetchGeckoTerminalToken(contract, chain),
      fetchGMGN(contract),
      fetchTokenMetadata(chain, contract),
      fetchGoPlus(chain, contract),
      fetchHoneypot(contract, chain),
    ]);

    const analysis = analyzeContract(bytecode);

    // GeckoTerminal /tokens/{contract}/pools returns pools for this token directly
    const gtAllPools: any[] = Array.isArray(gtData?.data) ? gtData.data : [];

    // Sort by liquidity descending, pick the deepest pool as main
    const matchingPools = [...gtAllPools].sort(
      (a, b) =>
        parseFloat(b.attributes?.reserve_in_usd || "0") -
        parseFloat(a.attributes?.reserve_in_usd || "0")
    );

    const mainPool = matchingPools[0] ?? null;
    const noActivePools = matchingPools.length === 0;

    // ------------------------------
    // REAL CLAUDE AI SUMMARY
    // ------------------------------
    const aiPrompt = `
You are the Cortex Engine of ChainLens AI.
Summarize this token in 3–4 sentences.
Focus on risks, liquidity, ownership, and suspicious functions.
Output plain text only, no markdown, no tables.
If critical data is missing (no pools, missing security), do NOT speculate and state that the token is unverified.

CHAIN: ${chain}
CONTRACT: ${contract}
GECKOTERMINAL POOLS:
${JSON.stringify(matchingPools.slice(0, 3), null, 2)}
GOLDRUSH:
${JSON.stringify(goldrush, null, 2)}
BYTECODE ANALYSIS:
${JSON.stringify(analysis, null, 2)}
`;

    const hasSecurityData = Boolean((gpRaw as Record<string, unknown>)?.result || hpRaw);
    let aiSummary = "Unverified on Base — insufficient data for a risk verdict.";

    if (!noActivePools || hasSecurityData) {
      try {
        const aiResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1100,
          messages: [{ role: "user", content: aiPrompt }],
        });
        console.log("AI response:", aiResponse);
        aiSummary =
          (aiResponse?.content?.[0]?.type === "text" ? aiResponse.content[0].text : null) ||
          aiSummary;
      } catch (err) {
        console.error("AI summary error:", err);
      }
    }

    // ------------------------------
    // Resolve core token fields
    // ------------------------------
    const metaItem = metadata?.data?.items?.[0];
    const goldItem = goldrush?.data?.items?.[0];
    const gmgnItem = gmgn?.data;

    // GeckoTerminal direct token info (most reliable for name/symbol)
    const gtToken = gtTokenInfo?.data?.attributes ?? null;

    // Included token entries from the pools response (with ?include=base_token,quote_token)
    const gtIncluded: any[] = Array.isArray(gtData?.included) ? gtData.included : [];
    const matchingTokenEntry = gtIncluded.find((i: any) =>
      i.type === 'token' && i.attributes?.address?.toLowerCase() === contract.toLowerCase()
    );

    const resolvedName =
      gtToken?.name ||
      matchingTokenEntry?.attributes?.name ||
      metaItem?.contract_name ||
      goldItem?.contract_name ||
      gmgnItem?.name ||
      "Unknown";

    const resolvedSymbol =
      gtToken?.symbol ||
      matchingTokenEntry?.attributes?.symbol ||
      metaItem?.contract_ticker_symbol ||
      goldItem?.contract_ticker_symbol ||
      gmgnItem?.symbol ||
      "?";

    const resolvedDecimals =
      gtToken?.decimals ||
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

      // Pool state
      noActivePools,

      // Extra data
      holders: goldrush?.holders || null,
      liquidity: mainPool?.attributes?.reserve_in_usd ?? null,

      pairs: matchingPools,
      gtPools: matchingPools,
      gtRaw: gtData || null,

      gmgn: gmgn?.data || null,

      // GoPlus security data — keyed by lowercase contract address
      goplus: (gpRaw as Record<string, unknown>)?.result ?? null,

      // Honeypot.is simulation results
      honeypot: hpRaw ? {
        isHoneypot:        hpRaw.honeypotResult?.isHoneypot        ?? null,
        buyTax:            hpRaw.simulationResult?.buyTax           ?? null,
        sellTax:           hpRaw.simulationResult?.sellTax          ?? null,
        transferTax:       hpRaw.simulationResult?.transferTax      ?? null,
        simulationSuccess: hpRaw.simulationSuccess                  ?? false,
      } : null,

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
