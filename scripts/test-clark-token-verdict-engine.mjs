import assert from 'node:assert/strict'
import fs from 'node:fs'
import { computeClarkTokenVerdictCore, renderClarkTokenVerdictForEvm, renderClarkTokenVerdictForSolana } from '../lib/server/clarkRouting.ts'

// CLARK-TOKEN-VERDICT FIX, DISCLOSED.
//
// Requested live: "Fix Clark token scan verdicts across every Token Scanner supported chain" —
// weak "Open Check" verdicts, no clear risk/watch/avoid decision, no guarantee the same honest
// scoring applied on every chain (Base, Ethereum, BNB, Robinhood Chain, Solana). This suite
// exercises the new chain-agnostic verdict engine (computeClarkTokenVerdictCore) directly with
// mock evidence for every tier, then checks the EVM and Solana render wrappers produce the exact
// required TOKEN READ format with no cross-chain wording leakage, plus that route.ts wires an
// in-chat "Deep Scan Token" action (not a page-navigating link) for both.

const EVM_VOCAB = { ownerLabel: "owner", mintLabel: "mint() callable", controlLabel: "Blacklist/transfer restriction" };
const SOLANA_VOCAB = { ownerLabel: "", mintLabel: "mint authority active", controlLabel: "Freeze authority active" };

function baseSafeInput(vocab) {
  return {
    honeypot: false, buyTaxPct: 1, sellTaxPct: 1, ownerRenounced: true, mintable: false, proxy: false,
    blacklist: false, lpStatus: "locked", liquidityUsd: 80_000, top1Pct: 4, top10Pct: 18,
    deployerRugHistoryCount: 0, vocab,
  };
}

// ── Partial Evidence: no usable evidence at all ──────────────────────────────────────────────
{
  const r = computeClarkTokenVerdictCore(baseSafeInput(EVM_VOCAB), false);
  assert.equal(r.verdict, "Partial Evidence");
  assert.equal(r.riskLevel, "Unknown");
}
{
  const emptyInput = { ...baseSafeInput(EVM_VOCAB), honeypot: null, buyTaxPct: null, sellTaxPct: null, lpStatus: null, top1Pct: null, top10Pct: null };
  const r = computeClarkTokenVerdictCore(emptyInput, true);
  assert.equal(r.verdict, "Partial Evidence", 'no security/LP/holders at all must never be scored, even if usableEvidence is true');
}

// ── Avoid / Critical tiers ───────────────────────────────────────────────────────────────────
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), honeypot: true }, true);
  assert.equal(r.verdict, "Avoid");
  assert.equal(r.riskLevel, "Critical");
}
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), sellTaxPct: 60 }, true);
  assert.equal(r.verdict, "Avoid", 'extreme sell tax must trigger Avoid');
}
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), blacklist: true }, true);
  assert.equal(r.verdict, "Avoid", 'active blacklist/transfer-restriction must trigger Avoid');
}
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), mintable: true, ownerRenounced: false }, true);
  assert.equal(r.verdict, "Avoid", 'mintable with active owner control must trigger Avoid');
}
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), lpStatus: "wallet_controlled", ownerRenounced: false }, true);
  assert.equal(r.verdict, "Avoid", 'wallet-controlled LP with active owner control must trigger Avoid');
}
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), deployerRugHistoryCount: 2 }, true);
  assert.equal(r.verdict, "Avoid", 'confirmed deployer rug history must trigger Avoid regardless of every other clean signal');
  assert.ok(r.risks.some(x => /2 confirmed prior rugs/.test(x)));
}

// ── High Risk tier ───────────────────────────────────────────────────────────────────────────
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), top1Pct: 60 }, true);
  assert.equal(r.verdict, "High Risk", 'very concentrated top-1 holder must trigger High Risk');
}
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), liquidityUsd: 1_000 }, true);
  assert.equal(r.verdict, "High Risk", 'low liquidity must trigger High Risk');
}
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), proxy: true }, true);
  assert.equal(r.verdict, "High Risk", 'active proxy control must trigger High Risk');
}

// ── Watch / Medium tier (deployer history unresolved is a real, honest gap) ─────────────────
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), deployerRugHistoryCount: null }, true);
  assert.equal(r.verdict, "Watch", 'unresolved deployer rug history must cap the verdict at Watch, never silently upgrade to Safer Watch');
  assert.equal(r.riskLevel, "Medium");
}
{
  const r = computeClarkTokenVerdictCore({ ...baseSafeInput(EVM_VOCAB), lpStatus: "unknown" }, true);
  assert.equal(r.verdict, "High Risk", 'unconfirmed LP control is a High Risk trigger (lpControlUnclear), not just a Watch-tier gap');
}

// ── Safer Watch tier — every gap closed ──────────────────────────────────────────────────────
{
  const r = computeClarkTokenVerdictCore(baseSafeInput(EVM_VOCAB), true);
  assert.equal(r.verdict, "Safer Watch");
  assert.equal(r.riskLevel, "Low");
  assert.equal(r.confidence, "High");
}

// ── Solana: never asserts EVM-only fields, never fabricates unsupported checks ──────────────
{
  const r = computeClarkTokenVerdictCore(baseSafeInput(SOLANA_VOCAB), true);
  // ownerLabel is "" for Solana, so no ownership-gap line should ever be produced even though
  // ownerRenounced itself is never populated by the Solana caller (always passed null there).
  assert.ok(!r.missingEvidence.some(x => /Ownership status/.test(x)), 'Solana vocab must suppress the EVM-only ownership missing-evidence line');
}
{
  // The real Solana caller (renderClarkTokenVerdictForSolana) always passes lpStatus: null with
  // lpUnsupportedOnChain: true, since LP lock/burn proof is not supported on Solana yet. That must
  // never be scored as a real High Risk signal (it's a chain-capability gap, not a detected risk),
  // but it does mean a gap always remains, so Solana can never honestly claim the fully-clear Safer
  // Watch tier through this path — Watch is the honest ceiling even with every other signal clean.
  const solanaCleanInput = { ...baseSafeInput(SOLANA_VOCAB), lpStatus: null, lpUnsupportedOnChain: true };
  const r = computeClarkTokenVerdictCore(solanaCleanInput, true);
  assert.notEqual(r.verdict, "High Risk", 'unsupported-on-chain LP data must not be scored as a real High Risk signal');
  assert.equal(r.verdict, "Watch", 'Solana can never reach Safer Watch since LP control can never be confirmed there — Watch is the honest ceiling');
}
{
  const rendered = renderClarkTokenVerdictForSolana({
    tokenAddress: "SoLTokenMintAddress11111111111111111111111",
    tokenName: "Test Token", tokenSymbol: "TEST",
    mintAuthority: null, mintAuthorityResolved: true,
    freezeAuthority: null, freezeAuthorityResolved: true,
    marketCap: 500_000, fdv: 600_000, liquidityUsd: 90_000, volume24h: 40_000,
    primaryDexLabel: "Raydium", primaryPoolAddress: "PoolAddr1111111111111111111111111111111111",
    top1Pct: 5, top10Pct: 20, accountsSampled: 500,
    likelyCreator: "CreatorAddr111111111111111111111111111111", creatorConfidenceTier: "high",
    deployerRugHistoryCount: 0,
    usableEvidence: true,
  });
  assert.match(rendered, /^TOKEN READ/);
  assert.match(rendered, /Chain:\s*Solana/);
  // "honeypot" is allowed to appear only inside the honest Missing Evidence label naming what
  // wasn't checked ("Security simulation (honeypot/tax): not returned") — never as a claimed result.
  assert.doesNotMatch(rendered, /honeypot simulation (?:flagged|detected|clear|not detected)/i, 'Solana render must never claim a honeypot result — that check does not exist on Solana yet');
  assert.doesNotMatch(rendered, /\bproxy\b/i, 'Solana render must never use EVM-only proxy vocabulary');
  assert.doesNotMatch(rendered, /\bowner renounced\b/i, 'Solana render must never assert EVM-only ownership-renounced wording');
  assert.match(rendered, /24h Change:\s*unverified/, 'Solana market data has no 24h-change field — must render as honestly unverified, never fabricated');
}

// ── EVM render: exact required format, no raw debug fields ──────────────────────────────────
{
  const ev = {
    ok: true,
    token: { name: "Test Token", symbol: "TEST", address: "0x0000000000000000000000000000000000dead" },
    market: { price: 0.01, change24h: 5, volume24h: 100_000, liquidity: 80_000, marketCap: 1_000_000, fdv: 1_200_000 },
    holders: { top1: 4, top10: 18, holderCount: 900, status: "ok" },
    security: { honeypot: false, buyTax: 1, sellTax: 1, ownerRenounced: true, mintable: false, proxy: false, blacklist: false, securityStatus: "ok", simulationStatus: "ok", riskLevel: "Low", missing: [], missingReason: null },
    lpControl: { status: "locked", reason: "locked", confidence: "High", poolType: "v2", proofApplicability: "applicable", displayLpModel: "locked", lockStatus: "locked", burnStatus: null, proofStatus: "confirmed", rawLpState: "locked", lpController: null, lpControllerType: null, positionProofStatus: "confirmed", positionProofReason: null },
    deployerProfile: { rugHistory: 0 },
  };
  const rendered = renderClarkTokenVerdictForEvm(ev, "0x0000000000000000000000000000000000dead", "Base", true);
  assert.match(rendered, /^TOKEN READ/);
  assert.match(rendered, /Verdict:\s*\nSafer Watch/);
  assert.doesNotMatch(rendered, /_token(Api|ScanDebug|RouteStatus)/i, 'rendered TOKEN READ text must never leak raw internal debug field names');
  assert.doesNotMatch(rendered, /\bfreeze authority\b/i, 'EVM render must never use Solana-only freeze-authority vocabulary');
}

// ── route.ts wiring: "Deep Scan Token" must be an in-chat prompt action, never a page link ───
const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(
  routeCode,
  /\{ label: "Deep Scan Token", prompt: `deep scan \$\{tokenAddress\}`, kind: "prompt" as const \}/,
  'the token_scan intent must expose Deep Scan Token as an in-chat prompt action, not a link'
)
assert.match(
  routeCode,
  /\{ label: "Deep Scan Token", prompt: `deep scan \$\{r\.address\}`, kind: "prompt" as const \}/,
  'the token_safety intent must expose Deep Scan Token as an in-chat prompt action, not a link'
)
// Both token_scan and token_safety must actually set ui.actions — the frontend only ever renders
// buttons from payload.ui.actions (see app/terminal/clark-ai/page.tsx), so a handler that only set
// the legacy top-level `actions` string list would silently show zero buttons.
const uiActionsBlocks = (routeCode.match(/ui: \{\s*\n\s*intentBadge: "Token Read",/g) ?? []).length
assert.ok(uiActionsBlocks >= 3, 'token_scan, token_safety, and the Solana full-verdict read must all set ui.actions with intentBadge "Token Read"')

console.log('test-clark-token-verdict-engine.mjs: all assertions passed')
