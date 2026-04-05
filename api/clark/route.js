import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

// --------------------------------------
// 1. MARKET INTEL AGENT (HAIKU) PROMPT
// --------------------------------------
const MARKET_INTEL_PROMPT = `
You are Clark’s Market Intel Agent.

Your job:
- Take the user message AND all API data provided (DexScreener, CoinGecko, GoldRush, LunarCrush, Zerion Go+, Alchemy).
- Extract clean, simple, factual market intel.
- If API data is missing, incomplete, or empty, DO NOT block the user.
- Never say “insufficient data.”
- Never ask for more information.
- Always produce intel.

Output format:

INTEL:
- Liquidity: ...
- Volume: ...
- Momentum: ...
- Market Cap: ...
- Deployer: ...
- Whale Activity: ...
- Sentiment: ...
- Risk Flags: ...
- On-chain Activity: ...
- Notes: ...

Keep it short, factual, and flexible.
Never block. Never refuse.
`;


// --------------------------------------
// 2. CLARK-CORE (SONNET) PROMPT
// --------------------------------------
const CLARK_CORE_PROMPT = `
You are Clark-Core, the main hybrid intelligence.

You receive:
1. The user’s question
2. The API DATA block
3. The INTEL block from the Market Intel Agent

Your job:
- Merge all information.
- Answer ANY crypto question.
- Never refuse.
- Never say “insufficient data.”
- If API data is missing, use reasoning, patterns, and general market knowledge.
- Maintain a confident, Base-native, hybrid analyst tone.
- Provide clear, structured insights.

Output structure:

SETUP:
- What the user wants
- What the data shows
- What the intel implies

ANALYSIS:
- Liquidity interpretation
- Volume interpretation
- Momentum interpretation
- Deployer behavior
- Whale activity
- Sentiment context
- On-chain activity
- Sector context

FRAMEWORK:
- How to think about this token or question
- What matters most
- What to ignore

SUMMARY:
- 3–5 sharp takeaways
`;


// --------------------------------------
// 3. MAIN ROUTE HANDLER
// --------------------------------------
export async function POST(req) {
  const body = await req.json();
  const userMessage = body.message;

  // Load Clark's personality (system.md)
  const systemPrompt = fs.readFileSync(
    path.join(process.cwd(), "clark/system.md"),
    "utf8"
  );

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });


  // --------------------------------------
  // 4. FETCH ALL API DATA
  // --------------------------------------
  const apiData = {};

  // ------------------------------
  // DexScreener (public API)
  // ------------------------------
  const tokenAddress = body.tokenAddress || ""; // you decide how to pass this in

  const dexscreener = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
  )
    .then(res => res.json())
    .catch(() => null);

  apiData.dexscreener = dexscreener;

  // ------------------------------
  // Add your other APIs here:
  // - CoinGecko CG-CUrNMMdo77ZD3UbeHX3zEWm5
  // - GoldRush cqt_rQcdwV6kg8rfyDHtfqxf4ffRdtdb
  // - LunarCrush njw04rygaejibnsmmsnv25cnemmysqceptqoksw
  // - Zerion Go+ zk_30b6d47dea3c4c189d0596eb1cb8f19a
  // - Alchemy DqZs00ga4VwRXWAwwFCVv
  // ------------------------------



  // --------------------------------------
  // 5. CALL HAIKU (MARKET INTEL AGENT)
  // --------------------------------------
  const haikuResponse = await client.messages.create({
    model: "claude-3-haiku",
    max_tokens: 300,
    system: MARKET_INTEL_PROMPT,
    messages: [
      { role: "user", content: userMessage },
      { role: "assistant", content: JSON.stringify(apiData) }
    ],
  });

  const intel = haikuResponse.content[0].text;


  // --------------------------------------
  // 6. CALL SONNET (CLARK-CORE)
  // --------------------------------------
  const sonnetResponse = await client.messages.create({
    model: "claude-3-sonnet",
    max_tokens: 800,
    system: systemPrompt + "\n\n" + CLARK_CORE_PROMPT,
    messages: [
      {
        role: "user",
        content: `
USER MESSAGE:
${userMessage}

API DATA:
${JSON.stringify(apiData)}

MARKET INTEL:
${intel}
        `,
      },
    ],
  });

  const finalReply = sonnetResponse.content[0].text;

  return NextResponse.json({ reply: finalReply });
}