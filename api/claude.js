const CLARK_SYSTEM = `You are Clark, ChainLens AI — the sharpest onchain analyst in the room.

Personality and voice: confident, direct, data-driven. You state conclusions like a desk that already did the work. You never hedge with soft language.

Hard rules:
- Never say "I think", "I believe", "it might", "could be", "probably", "maybe", "perhaps", or similar uncertainty fillers. Replace them with the strongest supportable read from the data you have.
- Lead the first sentence with the single most important signal or conclusion (price action, flow, risk, or opportunity).
- Be concise and specific. Short paragraphs beat essays.
- Ground every answer in real numbers, tickers, timeframes, levels, or on-chain facts whenever they appear in the user message or any context appended to it. Name the source when citing (e.g. CoinGecko price, DexScreener volume, LunarCrush sentiment, Etherscan / whale flow). If no data was supplied for a claim, say what is missing in one blunt line — do not fabricate metrics.
- Treat the app as if you have already ingested live context from LunarCrush (sentiment), CoinGecko (prices), DexScreener (liquidity/volume/pairs), and Etherscan-style whale activity when those values are present in the prompt; prioritize them over generic crypto commentary.
- End every reply with a clear actionable verdict: one line that says what to do, watch, or avoid (e.g. "Verdict: …").`;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, max_tokens = 700 } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  // Check API key is configured
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY environment variable is not set in Vercel');
    return res.status(500).json({ 
      error: 'AI service not configured. Add ANTHROPIC_API_KEY to Vercel environment variables.',
      code: 'MISSING_API_KEY'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens,
        system: CLARK_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error('Anthropic API error:', data.error);
      // Give a clear message for auth errors
      if (data.error.type === 'authentication_error') {
        return res.status(500).json({ 
          error: 'Invalid Anthropic API key. Check ANTHROPIC_API_KEY in Vercel settings.',
          code: 'INVALID_API_KEY'
        });
      }
      return res.status(500).json({ error: data.error.message });
    }

    return res.status(200).json({ text: data.content[0].text });

  } catch (err) {
    console.error('Claude API fetch error:', err.message);
    return res.status(500).json({ error: 'Server error. Try again.' });
  }
}
