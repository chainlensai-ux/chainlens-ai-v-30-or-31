import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export interface CortexVerdict {
  risk_score: number;
  risk_tier: "low" | "medium" | "high" | "extreme";
  positives: string[];
  negatives: string[];
  contract_safety: string;
  liquidity_analysis: string;
  volatility_analysis: string;
  whale_flow: string;
  overall_assessment: string;
  cortex_verdict: string;
}

const CORTEX_SYSTEM_PROMPT = `You are CORTEX, the analytical risk engine inside ChainLens AI.

Your job is to analyze a Base token using ONLY the structured data provided by the user.
You produce a risk-focused assessment — NOT financial advice.

HARD RULES:
1. Do NOT tell the user to buy, sell, hold, or enter a trade.
2. Do NOT say "this is a good trade", "this is profitable", or any equivalent.
3. Do NOT give price targets or entry/exit points.
4. You MAY assess: risk level, volatility, liquidity stability, contract safety, and whale behavior.
5. You MAY highlight positives and negatives based solely on the data.
6. Output MUST be valid JSON — no markdown, no explanations, no preamble.
7. If a data field is missing or null, use "Insufficient data" for string fields.
8. risk_score must be 0–100 (integer). 0 = extremely safe, 100 = extremely risky.

SCORING GUIDELINES:
- Liquidity < $50k → +30 risk
- Liquidity < $100k → +15 risk
- Large negative 24h price change (> -20%) → +20 risk
- Fragmented or thin liquidity pools → +10 risk
- High volatility → +10 risk
- Whale accumulation signals → -10 risk
- Whale distribution signals → +15 risk
- Locked liquidity → -10 risk
- Unlocked or unknown liquidity → +10 risk

CORTEX VERDICT STYLE:
- Short, sharp, analytical (2–3 sentences max).
- No hype. No trading recommendations.
- Focus on risk, stability, and observable behavior.

OUTPUT FORMAT — return ONLY this JSON, no other text:
{
  "risk_score": <0-100 integer>,
  "risk_tier": <"low"|"medium"|"high"|"extreme">,
  "positives": [<string>, ...],
  "negatives": [<string>, ...],
  "contract_safety": "<string>",
  "liquidity_analysis": "<string>",
  "volatility_analysis": "<string>",
  "whale_flow": "<string>",
  "overall_assessment": "<string>",
  "cortex_verdict": "<string>"
}`;

function isValidVerdict(obj: unknown): obj is CortexVerdict {
  if (!obj || typeof obj !== "object") return false;
  const v = obj as Record<string, unknown>;
  return (
    typeof v.risk_score === "number" &&
    ["low", "medium", "high", "extreme"].includes(v.risk_tier as string) &&
    Array.isArray(v.positives) &&
    Array.isArray(v.negatives) &&
    typeof v.contract_safety === "string" &&
    typeof v.liquidity_analysis === "string" &&
    typeof v.volatility_analysis === "string" &&
    typeof v.whale_flow === "string" &&
    typeof v.overall_assessment === "string" &&
    typeof v.cortex_verdict === "string"
  );
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }

  let tokenData: unknown;
  try {
    const body = await req.json();
    tokenData = body.tokenData;
    if (!tokenData) {
      return NextResponse.json(
        { ok: false, error: "tokenData is required" },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const client = new Anthropic({ apiKey });

  const userContent = `Analyze this token and return the CORTEX risk verdict JSON:

${JSON.stringify(tokenData, null, 2)}

Return ONLY the JSON object. No other text.`;

  let raw: string;
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: CORTEX_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    const block = message.content[0];
    if (!block || block.type !== "text") {
      return NextResponse.json(
        { ok: false, error: "Unexpected response shape from Claude" },
        { status: 502 }
      );
    }
    raw = block.text.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Claude API error";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }

  // Strip optional markdown code fences
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let verdict: unknown;
  try {
    verdict = JSON.parse(stripped);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Claude returned non-JSON output", raw },
      { status: 502 }
    );
  }

  if (!isValidVerdict(verdict)) {
    return NextResponse.json(
      { ok: false, error: "Claude response failed schema validation", raw },
      { status: 502 }
    );
  }

  // Clamp risk_score to valid range
  verdict.risk_score = Math.max(0, Math.min(100, Math.round(verdict.risk_score)));

  return NextResponse.json({ ok: true, verdict });
}
