// api/memory-status.js — ChainLens Memory Service Status Check
// Returns the status of the AI memory/context service configuration

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const status = {
    ok: false,
    checks: {},
    timestamp: new Date().toISOString(),
  };

  // Check Anthropic API key (required for AI memory features)
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  status.checks.anthropic_api_key = {
    configured: hasAnthropicKey,
    message: hasAnthropicKey
      ? 'Anthropic API key is configured'
      : 'Missing ANTHROPIC_API_KEY environment variable',
  };

  // Check Supabase (required for persistent memory/data storage)
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_KEY;
  status.checks.supabase = {
    configured: hasSupabaseUrl && hasSupabaseKey,
    message:
      hasSupabaseUrl && hasSupabaseKey
        ? 'Supabase is configured'
        : `Missing: ${[
            !hasSupabaseUrl && 'SUPABASE_URL',
            !hasSupabaseKey && 'SUPABASE_SERVICE_KEY',
          ]
            .filter(Boolean)
            .join(', ')}`,
  };

  // Verify Supabase connectivity if credentials are present
  if (hasSupabaseUrl && hasSupabaseKey) {
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      });
      status.checks.supabase.reachable = r.ok || r.status === 400; // 400 = reached but no table specified
      status.checks.supabase.message = status.checks.supabase.reachable
        ? 'Supabase is reachable'
        : `Supabase returned HTTP ${r.status}`;
    } catch (err) {
      status.checks.supabase.reachable = false;
      status.checks.supabase.message = `Supabase unreachable: ${err.message}`;
    }
  }

  // Overall status: all required services configured
  status.ok = hasAnthropicKey && hasSupabaseUrl && hasSupabaseKey;

  return res.status(status.ok ? 200 : 503).json(status);
}
