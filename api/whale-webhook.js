/**
 * Alchemy Notify — Address Activity webhook (ETH_MAINNET + BASE_MAINNET).
 * URL: https://YOUR_DOMAIN/api/whale-webhook?secret=WHALE_WEBHOOK_SECRET
 *
 * Supabase (service role):
 *   create table if not exists public.whale_alerts (
 *     id uuid primary key default gen_random_uuid(),
 *     wallet_from text not null,
 *     wallet_to text not null,
 *     amount_usd numeric not null,
 *     token text not null,
 *     chain text not null,
 *     timestamp timestamptz not null default now(),
 *     entity_label text default '',
 *     cortex_insight text default ''
 *   );
 *   create index if not exists whale_alerts_timestamp_idx on public.whale_alerts (timestamp desc);
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHALE_WEBHOOK_SECRET = process.env.WHALE_WEBHOOK_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY;

const MIN_USD = 50000;

const STABLES = new Set([
  'USDC', 'USDT', 'DAI', 'USDBC', 'USDB', 'BUSD', 'TUSD', 'FRAX', 'LUSD', 'USDD', 'GUSD', 'PYUSD',
  'EURC', 'USDP', 'FDUSD', 'CRVUSD', 'USDE', 'DAI+', 'USDX', 'USDS',
]);

const ENTITY_BY_ADDR = {
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance 14',
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance 15',
  '0x3dcf0c7280d22c56529df1e5be5014871a2c85cf': 'Binance deposit',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance 16',
  '0x56eddb7aa87536c09ccc279347359fd641a4f0ba': 'Binance cold wallet',
};

function verifyQuerySecret(req) {
  if (!WHALE_WEBHOOK_SECRET) return { ok: false, reason: 'missing_env_secret' };
  const q = req.query || {};
  if (String(q.secret || '') !== String(WHALE_WEBHOOK_SECRET)) return { ok: false, reason: 'query_secret' };
  return { ok: true };
}

function entityLabel(from, to) {
  const fl = String(from || '').toLowerCase();
  const tl = String(to || '').toLowerCase();
  return ENTITY_BY_ADDR[fl] || ENTITY_BY_ADDR[tl] || '';
}

async function fetchCgSimple() {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd';
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ChainLens-WhaleWebhook/1' } });
    const j = r.ok ? await r.json() : {};
    const eth = Number(j?.ethereum?.usd);
    const btc = Number(j?.bitcoin?.usd);
    return {
      eth: Number.isFinite(eth) ? eth : 3000,
      btc: Number.isFinite(btc) ? btc : 95000,
    };
  } catch {
    return { eth: 3000, btc: 95000 };
  }
}

async function fetchTokenUsdMap(platform, addresses) {
  const uniq = [...new Set(addresses.map((a) => String(a || '').toLowerCase()).filter(Boolean))];
  if (!uniq.length) return {};
  const out = {};
  const chunkSize = 25;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const qs = `contract_addresses=${chunk.join(',')}&vs_currencies=usd`;
    const path =
      platform === 'base'
        ? `https://api.coingecko.com/api/v3/simple/token_price/base?${qs}`
        : `https://api.coingecko.com/api/v3/simple/token_price/ethereum?${qs}`;
    try {
      const r = await fetch(path, { headers: { Accept: 'application/json', 'User-Agent': 'ChainLens-WhaleWebhook/1' } });
      const j = r.ok ? await r.json() : {};
      for (const addr of chunk) {
        const row = j[addr] || j[addr.toLowerCase()];
        const u = row && Number(row.usd);
        if (Number.isFinite(u) && u > 0) out[addr.toLowerCase()] = u;
      }
    } catch { /* ignore */ }
  }
  return out;
}

function chainSlug(network) {
  if (network === 'BASE_MAINNET') return 'base';
  if (network === 'ETH_MAINNET') return 'ethereum';
  return null;
}

function cgPlatform(network) {
  return network === 'BASE_MAINNET' ? 'base' : 'ethereum';
}

async function oneLineCortex({ amountUsd, token, chain, from, to, entity }) {
  if (!ANTHROPIC_KEY) {
    return `CORTEX: ~$${Math.round(amountUsd).toLocaleString('en-US')} ${token} moved on ${chain}${entity ? ' involving ' + entity : ''} — watch whether this is inventory shift or directional flow.`;
  }
  const prompt = [
    'You are CORTEX for ChainLens whale alerts. Output EXACTLY ONE sentence (max 28 words).',
    'No hedging phrases. Lead with the sharpest trading signal this on-chain move suggests.',
    '',
    `USD notional: ~$${Math.round(amountUsd).toLocaleString('en-US')}`,
    `Asset: ${token}`,
    `Chain: ${chain}`,
    `From: ${from}`,
    `To: ${to}`,
    entity ? `Known entity: ${entity}` : 'Known entity: none',
  ].join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = (data.content && data.content[0] && data.content[0].text) ? String(data.content[0].text).trim() : '';
    const line = text.split(/\n+/)[0].trim();
    if (!line) throw new Error('empty');
    return line.match(/^cortex:/i) ? line : `CORTEX: ${line}`;
  } catch {
    return `CORTEX: ~$${Math.round(amountUsd).toLocaleString('en-US')} ${token} on ${chain}${entity ? ' (' + entity + ')' : ''} — size suggests institutional or OTC-style flow; confirm direction vs your book.`;
  }
}

async function insertAlert(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/whale_alerts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error('[whale-webhook] Supabase insert failed', r.status, t.slice(0, 500));
  }
  return r.ok;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const v = verifyQuerySecret(req);
  if (!v.ok) {
    return res.status(403).json({ error: 'Forbidden', reason: v.reason || 'auth' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  if (!payload || typeof payload !== 'object') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  if (payload.type !== 'ADDRESS_ACTIVITY') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const event = payload.event;
  const network = event && event.network;
  const activity = event && Array.isArray(event.activity) ? event.activity : [];
  const slug = chainSlug(network);
  if (!slug || !activity.length) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'network_or_activity' });
  }

  const createdAt = payload.createdAt ? new Date(payload.createdAt).toISOString() : new Date().toISOString();
  const { eth: ethUsd, btc: btcUsd } = await fetchCgSimple();
  const platform = cgPlatform(network);

  const needContracts = [];
  for (const act of activity) {
    if (!act || act.log?.removed) continue;
    const cat = String(act.category || '').toLowerCase();
    if (cat === 'erc721' || cat === 'erc1155') continue;
    const val = Number(act.value);
    if (!Number.isFinite(val) || val <= 0) continue;
    const asset = String(act.asset || '').toUpperCase();
    if (cat === 'token' || cat === 'erc20') {
      if (act.rawContract && act.rawContract.address && !STABLES.has(asset) && asset !== 'ETH' && asset !== 'WETH' && !asset.includes('BTC')) {
        needContracts.push(act.rawContract.address);
      }
    }
  }

  const contractPrices = await fetchTokenUsdMap(platform, needContracts);

  const candidates = [];
  for (const act of activity) {
    if (!act || act.log?.removed) continue;
    const cat = String(act.category || '').toLowerCase();
    if (cat === 'erc721' || cat === 'erc1155') continue;
    const val = Number(act.value);
    if (!Number.isFinite(val) || val <= 0) continue;

    const from = act.fromAddress || '';
    const to = act.toAddress || '';
    const asset = String(act.asset || 'ETH').toUpperCase();
    let usd = 0;

    if (cat === 'external' || cat === 'internal') {
      usd = val * ethUsd;
    } else if (STABLES.has(asset)) {
      usd = val;
    } else if (asset === 'WETH' || asset === 'ETH') {
      usd = val * ethUsd;
    } else if (asset.includes('BTC') || asset === 'WBTC' || asset === 'TBTC') {
      usd = val * btcUsd;
    } else if (act.rawContract && act.rawContract.address) {
      const px = contractPrices[String(act.rawContract.address).toLowerCase()];
      if (Number.isFinite(px)) usd = val * px;
    }

    if (usd < MIN_USD) continue;

    candidates.push({
      wallet_from: from,
      wallet_to: to,
      amount_usd: Math.round(usd * 100) / 100,
      token: act.asset || 'ETH',
      chain: slug,
      timestamp: createdAt,
      entity_label: entityLabel(from, to),
      _usd: usd,
    });
  }

  candidates.sort((a, b) => b._usd - a._usd);
  const capped = candidates.slice(0, 12);

  let stored = 0;
  for (const c of capped) {
    const label = c.entity_label || '';
    const insight = await oneLineCortex({
      amountUsd: c._usd,
      token: c.token,
      chain: c.chain,
      from: c.wallet_from,
      to: c.wallet_to,
      entity: label,
    });
    const { _usd, ...row } = c;
    row.cortex_insight = insight;
    const ok = await insertAlert(row);
    if (ok) stored += 1;
  }

  return res.status(200).json({ ok: true, processed: capped.length, stored });
}
