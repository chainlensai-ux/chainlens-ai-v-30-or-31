'use client'

// EARLY BUYERS — investigation report (presentation only).
//
// Renders an EarlyBuyerIntel response exactly as the engine returned it. Layout: overview → coverage
// → relationship findings → recipient evidence → full evidence details. Long lists start collapsed;
// every address, transaction link, coverage code and disclaimer of the response stays reachable.

import { useId, useMemo, useState, type ReactNode } from 'react'
import type { BuyerGroup, EarlyBuyer, EarlyBuyerIntel } from '@/lib/server/earlyBuyers/types'
import { earlyBuyerDisplayStatus } from '@/lib/server/earlyBuyers/types'
import {
  associationLabel, coverageCodes, DISCOVERY_OUTCOME_LABEL, explorerAddress, explorerTx, formatTimestamp,
  formatTokenAmount, orderedGroups, reasonLabel, recipientsByAmount, sharedBlockGroups, shortHex,
} from './earlyBuyersView'

const GROUP_PREVIEW = 4
const TX_PREVIEW = 3
const TABLE_PREVIEW = 10
const LIST_PREVIEW = 5
const POOL_ID = /^0x[0-9a-f]{64}$/i

type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'info'

const CSS = `
.eb-root{--eb-fg:#e4e7ea;--eb-text:#c2c5c8;--eb-muted:#9ea1a4;--eb-dim:#6f7275;--eb-line:rgba(158,161,164,.18);--eb-line-soft:rgba(158,161,164,.1);--eb-surface:rgba(12,15,18,.82);--eb-raised:rgba(17,21,25,.92);--eb-mint:#a9e9ec;--eb-teal:#1fd6dc;--eb-cyan:#62f1f1;--eb-good:#34d399;--eb-warn:#fbbf24;--eb-bad:#f87171;display:grid;gap:14px;color:var(--eb-text);font-family:var(--font-plex-mono),ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;min-width:0}
.eb-root *{box-sizing:border-box}
.eb-eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--eb-dim);font-weight:700;margin:0}
.eb-h{margin:0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--eb-mint);font-weight:800}
.eb-sub{margin:4px 0 0;color:var(--eb-dim);font-size:11px}
.eb-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.eb-btn{appearance:none;border:1px solid rgba(169,233,236,.35);background:rgba(169,233,236,.06);color:var(--eb-mint);border-radius:9px;padding:7px 12px;font:inherit;font-size:11px;font-weight:700;letter-spacing:.06em;cursor:pointer}
.eb-btn:hover{background:rgba(169,233,236,.12)}
.eb-btn:disabled{cursor:wait;opacity:.7}
.eb-link-btn{appearance:none;border:0;background:none;padding:2px 0;color:var(--eb-teal);font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-color:rgba(31,214,220,.35)}
.eb-root a{color:var(--eb-teal);text-decoration:none;border-bottom:1px solid rgba(31,214,220,.25)}
.eb-root a:hover{color:var(--eb-cyan);border-bottom-color:var(--eb-cyan)}
.eb-root :is(a,button,summary):focus-visible{outline:2px solid var(--eb-cyan);outline-offset:2px;border-radius:4px}
.eb-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.eb-tile{border:1px solid var(--eb-line);background:var(--eb-surface);border-radius:12px;padding:10px 12px;min-width:0}
.eb-tile-v{margin:4px 0 0;color:var(--eb-fg);font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.eb-tile-s{margin:2px 0 0;color:var(--eb-dim);font-size:10.5px;overflow-wrap:anywhere}
.eb-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800;letter-spacing:.08em;border:1px solid currentColor;white-space:nowrap}
.eb-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.eb-tone-good{color:var(--eb-good)}.eb-tone-warn{color:var(--eb-warn)}.eb-tone-bad{color:var(--eb-bad)}.eb-tone-muted{color:var(--eb-muted)}.eb-tone-info{color:var(--eb-mint)}
.eb-card{border:1px solid var(--eb-line);background:var(--eb-surface);border-radius:12px;padding:12px 14px;min-width:0}
.eb-card-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px 12px;flex-wrap:wrap}
.eb-card-title{margin:0;font-size:12px;font-weight:800;color:var(--eb-fg)}
.eb-tier{font-size:10px;font-weight:800;letter-spacing:.1em;border-radius:6px;padding:1px 6px;margin-right:8px;border:1px solid currentColor}
.eb-meta{color:var(--eb-dim);font-size:11px}
.eb-callout{border:1px solid var(--eb-line);border-left-width:3px;border-radius:12px;padding:12px 14px;background:var(--eb-raised)}
.eb-callout.eb-tone-good{border-left-color:var(--eb-good)}.eb-callout.eb-tone-warn{border-left-color:var(--eb-warn)}.eb-callout.eb-tone-muted,.eb-callout.eb-tone-bad{border-left-color:var(--eb-muted)}
.eb-callout p{margin:6px 0 0;color:var(--eb-text)}
.eb-reasons{margin:8px 0 0;padding-left:16px;display:grid;gap:3px;color:var(--eb-text)}
.eb-explain{margin:8px 0 0;color:var(--eb-text)}
.eb-note{margin:6px 0 0;color:var(--eb-dim);font-size:11px}
.eb-metrics{display:flex;flex-wrap:wrap;gap:6px 18px;margin:10px 0 0}
.eb-metric{display:grid;gap:1px}
.eb-metric dt{color:var(--eb-dim);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.eb-metric dd{margin:0;color:var(--eb-fg);font-weight:700;font-variant-numeric:tabular-nums}
.eb-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;padding:0;list-style:none}
.eb-chips li{border:1px solid var(--eb-line);background:rgba(255,255,255,.02);border-radius:7px;padding:2px 7px;font-size:11px}
.eb-section-title{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:4px 0 -4px}
.eb-table-wrap{border:1px solid var(--eb-line);border-radius:12px;overflow:hidden;background:var(--eb-surface)}
.eb-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.eb-table caption{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.eb-table th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--eb-dim);font-weight:700;padding:8px 10px;border-bottom:1px solid var(--eb-line);white-space:nowrap}
.eb-table td{padding:8px 10px;border-bottom:1px solid var(--eb-line-soft);vertical-align:top;min-width:0}
.eb-table tr:last-child td{border-bottom:0}
.eb-num{text-align:right}
.eb-amt{color:var(--eb-fg);font-weight:700;overflow-wrap:anywhere}
.eb-unit{color:var(--eb-dim);font-size:10px;margin-left:4px;font-weight:400}
.eb-unavail{color:var(--eb-dim);font-style:italic}
.eb-tags{display:inline-flex;gap:4px;margin-left:6px;vertical-align:middle}
.eb-tags span{font-size:9.5px;font-weight:800;letter-spacing:.06em;border-radius:5px;padding:0 5px;border:1px solid currentColor}
.eb-detail-row td{background:rgba(255,255,255,.015)}
.eb-kv{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:4px 14px;margin:0}
.eb-kv dt{color:var(--eb-dim)}
.eb-kv dd{margin:0;color:var(--eb-text);overflow-wrap:anywhere;min-width:0}
.eb-details{border:1px solid var(--eb-line);border-radius:12px;background:var(--eb-surface)}
.eb-details>summary{cursor:pointer;list-style:none;padding:10px 14px;color:var(--eb-mint);font-weight:800;font-size:11px;letter-spacing:.1em;text-transform:uppercase;display:flex;justify-content:space-between;gap:8px}
.eb-details>summary::-webkit-details-marker{display:none}
.eb-details>summary::after{content:"+";color:var(--eb-dim)}
.eb-details[open]>summary::after{content:"−"}
.eb-details-body{padding:0 14px 14px;display:grid;gap:14px}
.eb-block h5{margin:0 0 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--eb-dim)}
.eb-list{margin:0;padding:0;list-style:none;display:grid;gap:4px}
.eb-list li{overflow-wrap:anywhere}
.eb-code{color:var(--eb-dim);font-size:10.5px}
.eb-footer{border-top:1px solid var(--eb-line);padding-top:10px;color:var(--eb-dim);font-size:11px;display:grid;gap:4px}
.eb-footer p{margin:0}
@media (max-width:640px){
  .eb-table thead{display:none}
  .eb-table,.eb-table tbody{display:block;width:100%}
  .eb-table tr{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;border-bottom:1px solid var(--eb-line);padding:8px 12px}
  .eb-table tr:last-child{border-bottom:0}
  .eb-table td{display:block;border:0;padding:2px 0;text-align:left;min-width:0}
  .eb-table td[data-label="Recipient"],.eb-table td[data-label="First delivery"],.eb-table td[data-label="Evidence"],.eb-detail-row td{grid-column:1/-1}
  .eb-detail-row{display:block}
  .eb-table td[data-label]::before{content:attr(data-label);display:block;color:var(--eb-dim);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase}
  .eb-table td[data-label="Recipient"]::before{display:none}
  .eb-num{text-align:left}
  .eb-kv{grid-template-columns:1fr}
  .eb-kv dt{margin-top:4px}
}
`

const pillClass = (tone: Tone) => `eb-pill eb-tone-${tone}`
function Pill({ tone, children }: { tone: Tone; children: ReactNode }) { return <span className={pillClass(tone)}>{children}</span> }

function TxLink({ chain, hash, label }: { chain: string; hash: string; label?: string }) {
  return <a href={explorerTx(chain, hash)} target="_blank" rel="noopener noreferrer" aria-label={`${label ?? 'Transaction'} ${hash} on block explorer (opens in new tab)`} title={hash}>{label ? `${label} ` : ''}{shortHex(hash)} ↗</a>
}

function AddressLink({ chain, address }: { chain: string; address: string }) {
  if (POOL_ID.test(address)) return <span title={address}>{shortHex(address, 8, 6)}</span>
  return <a href={explorerAddress(chain, address)} target="_blank" rel="noopener noreferrer" aria-label={`Address ${address} on block explorer (opens in new tab)`} title={address}>{shortHex(address)}</a>
}

/** A list that shows `initial` items and a button revealing the rest (keyboard + screen-reader friendly). */
function Expandable<T>({ items, initial, render, noun, as = 'ul', className }: { items: T[]; initial: number; render: (item: T, index: number) => ReactNode; noun: string; as?: 'ul' | 'div'; className?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const shown = open ? items : items.slice(0, initial)
  const hidden = items.length - initial
  const List = as
  return <>
    <List id={id} className={className}>{shown.map((item, i) => render(item, i))}</List>
    {hidden > 0 && <button type="button" className="eb-link-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
      {open ? `Show fewer ${noun}` : `Show all ${items.length} ${noun} (+${hidden})`}
    </button>}
  </>
}

function Amount({ raw, decimals, symbol }: { raw: string; decimals: number | null; symbol: string | null }) {
  const a = formatTokenAmount(raw, decimals)
  const unit = a.unit === 'raw' ? 'raw' : (symbol ?? 'tokens')
  return <span className="eb-amt" title={a.unit === 'raw' ? `${a.exact} raw units (token decimals not verified)` : `${a.exact} ${unit} · ${raw} raw`}>{a.text}<span className="eb-unit">{unit}</span></span>
}

function Held({ raw, decimals, symbol }: { raw: string | null | undefined; decimals: number | null; symbol: string | null }) {
  // A missing balance means it was not read; it is never shown as zero. "0" is a measured zero.
  if (raw == null || raw === '') return <span className="eb-unavail" title="Current balance was not read">Unavailable</span>
  return <Amount raw={raw} decimals={decimals} symbol={symbol} />
}

function GroupCard({ group, chain, sharesHeld }: { group: BuyerGroup; chain: string; sharesHeld: boolean }) {
  const tone: Tone = group.tier === 'T1' ? 'info' : 'warn'
  return <article className="eb-card" aria-label={`${group.tier} ${associationLabel(group)}, ${group.wallets.length} recipients`}>
    <div className="eb-card-head">
      <h4 className="eb-card-title"><span className={`eb-tier eb-tone-${tone}`}>{group.tier}</span>{associationLabel(group)}</h4>
      <span className="eb-meta">{group.wallets.length} recipients · {group.transactions.length} {group.transactions.length === 1 ? 'transaction' : 'transactions'}</span>
    </div>
    <p className="eb-explain">{group.reason}.{group.tier === 'T1' ? ' Coordination and individual payment are not proven.' : ''}</p>
    {group.tier === 'T2' && <p className="eb-note">Association, not proof.</p>}
    {group.tier === 'T1' && <dl className="eb-metrics">
      <div className="eb-metric"><dt>Share of observed delivered amount</dt><dd>{group.boughtWithinEarlySetPct != null ? `${group.boughtWithinEarlySetPct}%` : <span className="eb-unavail">Unavailable</span>}</dd></div>
      <div className="eb-metric"><dt>Share of observed recipients’ current balances</dt><dd>{group.heldWithinEarlySetPct != null ? `${group.heldWithinEarlySetPct}%` : <span className="eb-unavail">{sharesHeld ? 'Unavailable' : 'Unavailable — balances not read for every recipient'}</span>}</dd></div>
    </dl>}
    <h5 className="eb-eyebrow" style={{ marginTop: 10 }}>Recipients</h5>
    <Expandable items={group.wallets} initial={GROUP_PREVIEW} noun="recipients" className="eb-chips" render={(w) => <li key={w}><AddressLink chain={chain} address={w} /></li>} />
    <h5 className="eb-eyebrow" style={{ marginTop: 10 }}>Evidence transactions</h5>
    <Expandable items={group.transactions} initial={TX_PREVIEW} noun="transactions" className="eb-chips" render={(h) => <li key={h}><TxLink chain={chain} hash={h} /></li>} />
  </article>
}

function RecipientRows({ buyer, chain, decimals, symbol, tags, holdingsRead }: { buyer: EarlyBuyer; chain: string; decimals: number | null; symbol: string | null; tags: string[]; holdingsRead: boolean }) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const first = buyer.evidence?.[0]
  const time = formatTimestamp(first?.timestampSec)
  return <>
    <tr>
      <td data-label="Recipient"><AddressLink chain={chain} address={buyer.wallet} />{tags.length > 0 && <span className="eb-tags">{tags.map((t) => <span key={t} className={t === 'T1' ? 'eb-tone-info' : t === 'T2' ? 'eb-tone-warn' : 'eb-tone-muted'}>{t}</span>)}</span>}</td>
      <td data-label="Received in window" className="eb-num"><Amount raw={buyer.boughtRaw} decimals={decimals} symbol={symbol} /></td>
      <td data-label="Current balance" className="eb-num">{holdingsRead ? <Held raw={buyer.heldRaw} decimals={decimals} symbol={symbol} /> : <span className="eb-unavail">Unavailable</span>}</td>
      <td data-label="First delivery">{first ? <>block {first.block}{time ? <span className="eb-meta"> · {time}</span> : null}</> : <span className="eb-unavail">—</span>}</td>
      <td data-label="Evidence">
        {buyer.transactions[0] ? <TxLink chain={chain} hash={buyer.transactions[0]} /> : null}
        {' '}<button type="button" className="eb-link-btn" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : buyer.transactions.length > 1 ? `Details (+${buyer.transactions.length - 1})` : 'Details'}</button>
      </td>
    </tr>
    {open && <tr className="eb-detail-row" id={detailId}>
      <td colSpan={5}>
        <dl className="eb-kv">
          <dt>Wallet</dt><dd>{POOL_ID.test(buyer.wallet) ? buyer.wallet : <a href={explorerAddress(chain, buyer.wallet)} target="_blank" rel="noopener noreferrer">{buyer.wallet} ↗</a>}</dd>
          <dt>Received (exact)</dt><dd>{formatTokenAmount(buyer.boughtRaw, decimals).exact} {formatTokenAmount(buyer.boughtRaw, decimals).unit === 'raw' ? 'raw units' : symbol ?? 'tokens'} · {buyer.boughtRaw} raw</dd>
          <dt>Current balance (exact)</dt><dd>{holdingsRead && buyer.heldRaw != null && buyer.heldRaw !== '' ? `${formatTokenAmount(buyer.heldRaw, decimals).exact} ${formatTokenAmount(buyer.heldRaw, decimals).unit === 'raw' ? 'raw units' : symbol ?? 'tokens'} · ${buyer.heldRaw} raw` : 'Unavailable — not read (not a zero balance)'}</dd>
          <dt>Blocks</dt><dd>{buyer.blocks.join(', ') || '—'}</dd>
          <dt>Transactions</dt><dd><ul className="eb-list">{buyer.transactions.map((h) => <li key={h}><TxLink chain={chain} hash={h} /></li>)}</ul></dd>
          <dt>Delivery evidence</dt><dd>{buyer.evidence && buyer.evidence.length > 0 ? <ul className="eb-list">{buyer.evidence.map((e) => <li key={`${e.txHash}:${e.block}`}>Pool <AddressLink chain={chain} address={e.pool} /> · block {e.block}{formatTimestamp(e.timestampSec) ? ` · ${formatTimestamp(e.timestampSec)}` : ''} · <TxLink chain={chain} hash={e.txHash} /> <span className="eb-code">({e.reason})</span></li>)}</ul> : 'No per-delivery evidence on this record'}</dd>
          <dt>Payment</dt><dd>Not proven. Receiving tokens from the pool does not show this wallet paid for them.</dd>
        </dl>
      </td>
    </tr>}
  </>
}

export default function EarlyBuyersReport({ intel, chain, decimals, tokenSymbol, decimalsSource }: { intel: EarlyBuyerIntel; chain: string; decimals: number | null; tokenSymbol: string | null; decimalsSource?: string }) {
  const labels = earlyBuyerDisplayStatus(intel)
  const groups = useMemo(() => orderedGroups(intel.groups), [intel.groups])
  const recipients = useMemo(() => recipientsByAmount(intel.buyers), [intel.buyers])
  const t3 = useMemo(() => sharedBlockGroups(intel), [intel])
  const codes = coverageCodes(intel.coverage.reasons)
  const t1 = groups.filter((g) => g.tier === 'T1'), t2 = groups.filter((g) => g.tier === 'T2')
  const membership = useMemo(() => {
    const m = new Map<string, Set<string>>()
    const add = (w: string, tag: string) => { const s = m.get(w.toLowerCase()) ?? new Set<string>(); s.add(tag); m.set(w.toLowerCase(), s) }
    for (const g of intel.groups) for (const w of g.wallets) add(w, g.tier)
    if (t3.matchesEngine) for (const b of t3.blocks) for (const w of b.wallets) add(w, 'T3')
    return m
  }, [intel.groups, t3])
  const holdingsRead = labels.holdings === 'AVAILABLE' || labels.holdings === 'PARTIAL'
  const launchTone: Tone = labels.launch === 'VERIFIED' ? 'good' : labels.launch === 'PARTIAL' ? 'warn' : 'muted'
  const holdingsTone: Tone = labels.holdings === 'AVAILABLE' ? 'good' : labels.holdings === 'PARTIAL' ? 'warn' : labels.holdings === 'FAILED' ? 'bad' : 'muted'
  const w = intel.window
  const windowLabel = w.startBlock != null && w.endBlock != null ? `${w.startBlock}–${w.endBlock}` : 'Not established'
  const windowBlocks = w.startBlock != null && w.endBlock != null ? w.endBlock - w.startBlock + 1 : null
  const holdingsFromCache = labels.holdings === 'AVAILABLE' && intel.budget.calls === 0
  const associationsMayBeSuppressed = intel.groups.length === 0 && (intel.launch.status !== 'verified' || intel.discovery?.complete === false)

  return <div className="eb-root">
    <style>{CSS}</style>

    {/* ── Overview ─────────────────────────────────────────────────────────── */}
    <section aria-label="Investigation overview" className="eb-overview">
      <div className="eb-tile"><p className="eb-eyebrow">Launch investigation</p><p className="eb-tile-v"><Pill tone={launchTone}>{labels.launch}</Pill></p><p className="eb-tile-s">{intel.coverage.provisional ? 'Provisional — window not yet finalized' : 'Bounded first-trade window'}</p></div>
      <div className="eb-tile"><p className="eb-eyebrow">Launch block</p><p className="eb-tile-v">{intel.launch.block ?? '—'}</p><p className="eb-tile-s">{intel.launch.status === 'verified' ? 'Verified first liquidity' : intel.launch.status === 'estimated' ? 'Estimated, not verified' : intel.launch.status === 'unsupported_launch_venue' ? 'Unsupported launch venue' : 'Unavailable'}</p></div>
      <div className="eb-tile"><p className="eb-eyebrow">First-trade window</p><p className="eb-tile-v">{windowLabel}</p><p className="eb-tile-s">{windowBlocks != null ? `${windowBlocks} blocks read` : '—'}</p></div>
      <div className="eb-tile"><p className="eb-eyebrow">Pool-sourced deliveries</p><p className="eb-tile-v">{w.buysObserved}</p><p className="eb-tile-s">Token deliveries, not verified purchases</p></div>
      <div className="eb-tile"><p className="eb-eyebrow">Unique recipients</p><p className="eb-tile-v">{intel.buyers.length}</p><p className="eb-tile-s">Observed in the window</p></div>
      <div className="eb-tile"><p className="eb-eyebrow">Associations</p><p className="eb-tile-v">{t1.length} T1 · {t2.length} T2</p><p className="eb-tile-s">{intel.sameBlockCount} recipients in shared blocks (T3)</p></div>
      <div className="eb-tile"><p className="eb-eyebrow">Current holdings</p><p className="eb-tile-v"><Pill tone={holdingsTone}>{labels.holdings}</Pill></p><p className="eb-tile-s">{holdingsFromCache ? 'Served from the short-lived holdings cache' : labels.holdings === 'AVAILABLE' ? 'Read for every recipient' : labels.holdings === 'PARTIAL' ? 'Some balances not read' : 'Not read — not zero'}</p></div>
    </section>

    {/* ── Coverage ─────────────────────────────────────────────────────────── */}
    <section aria-label="Coverage" className={`eb-callout eb-tone-${launchTone}`}>
      <div className="eb-card-head"><h4 className="eb-card-title">{labels.launch === 'VERIFIED' ? 'Verified within the first-trade window' : labels.launch === 'PARTIAL' ? 'Partial evidence' : 'Investigation unavailable'}</h4>{intel.coverage.provisional && <Pill tone="warn">PROVISIONAL</Pill>}</div>
      {labels.launch === 'VERIFIED' && <p>Launch pool chronology was verified and no coverage limit was reached while reading blocks {windowLabel}. This covers only that bounded window; it is not a complete list of launch buyers.</p>}
      {labels.launch === 'PARTIAL' && <p>Part of the evidence in this window could not be read. Missing data is not evidence of no activity.</p>}
      {labels.launch === 'UNAVAILABLE' && <p>{codes[0] ? reasonLabel(codes[0]) : 'No launch evidence could be established.'}</p>}
      {codes.length > 0 && <ul className="eb-reasons">{codes.map((c) => <li key={c}>{reasonLabel(c)}</li>)}</ul>}
      {intel.launchDistributions.length > 0 && <p className="eb-note">{intel.launchDistributions.length} creator-origin launch distributions observed separately; not counted as buys.</p>}
    </section>

    {/* ── Relationship findings ────────────────────────────────────────────── */}
    <section aria-label="Relationship findings" style={{ display: 'grid', gap: 10 }}>
      <div className="eb-section-title"><h3 className="eb-h">Relationship findings</h3><span className="eb-meta">Associations only — none prove ownership or a bundle</span></div>
      {groups.map((g, i) => <GroupCard key={`${g.tier}-${g.associationType ?? ''}-${i}`} group={g} chain={chain} sharesHeld={holdingsRead} />)}
      {intel.sameBlockCount > 0 && <article className="eb-card" aria-label={`T3 shared block timing, ${intel.sameBlockCount} recipients`}>
        <div className="eb-card-head">
          <h4 className="eb-card-title"><span className="eb-tier eb-tone-muted">T3</span>Shared block timing</h4>
          <span className="eb-meta">{intel.sameBlockCount} recipients{t3.matchesEngine ? ` · ${t3.blocks.length} ${t3.blocks.length === 1 ? 'block' : 'blocks'}` : ''}</span>
        </div>
        <p className="eb-explain">{intel.sameBlockCount} recipients shared a block. Timing alone proves no coordination or ownership.</p>
        {t3.matchesEngine
          ? <Expandable items={t3.blocks} initial={3} noun="blocks" as="div" render={(b) => <div key={b.block} style={{ marginTop: 8 }}><span className="eb-meta">Block {b.block} · {b.wallets.length} recipients</span><Expandable items={b.wallets} initial={GROUP_PREVIEW} noun="recipients" className="eb-chips" render={(wallet) => <li key={wallet}><AddressLink chain={chain} address={wallet} /></li>} /></div>} />
          : <p className="eb-note">The per-block breakdown is not shown because it could not be reproduced exactly from this result.</p>}
      </article>}
      {groups.length === 0 && intel.sameBlockCount === 0 && <p className="eb-note">{associationsMayBeSuppressed ? 'T1 and T2 checks only run when launch pool chronology is fully verified. Discovery for this result was incomplete, so an empty list here does not mean no associations exist.' : 'No shared-transaction or shared-block associations were observed in the read window. This covers only that window.'}</p>}
      {groups.length === 0 && intel.sameBlockCount > 0 && associationsMayBeSuppressed && <p className="eb-note">T1 and T2 checks only run when launch pool chronology is fully verified. Discovery for this result was incomplete, so no T1/T2 findings are shown.</p>}
    </section>

    {/* ── Recipient evidence ───────────────────────────────────────────────── */}
    {recipients.length > 0 && <section aria-label="Recipient evidence" style={{ display: 'grid', gap: 10 }}>
      <div className="eb-section-title">
        <h3 className="eb-h">Recipient evidence</h3>
        <span className="eb-meta">{recipients.length} recipients · sorted by amount received · {decimals != null ? `amounts in ${tokenSymbol ?? 'token'} units${decimalsSource ? ` (${decimalsSource})` : ''}` : 'raw on-chain units — token decimals not verified'}</span>
      </div>
      <RecipientTable recipients={recipients} chain={chain} decimals={decimals} symbol={tokenSymbol} membership={membership} holdingsRead={holdingsRead} />
    </section>}

    {/* ── Evidence details ─────────────────────────────────────────────────── */}
    <details className="eb-details">
      <summary>Evidence details</summary>
      <div className="eb-details-body">
        <div className="eb-block"><h5>Launch evidence</h5>
          <dl className="eb-kv">
            <dt>Launch status</dt><dd>{intel.launch.status}</dd>
            <dt>Launch block</dt><dd>{intel.launch.block ?? 'unverified'}</dd>
            <dt>Launch pool</dt><dd>{intel.launch.pool ? <AddressLink chain={chain} address={intel.launch.pool} /> : '—'}</dd>
            <dt>Pool creation</dt><dd>{intel.launch.creationTx ? <TxLink chain={chain} hash={intel.launch.creationTx} /> : '—'}</dd>
            <dt>First liquidity</dt><dd>{intel.launch.liquidityTx ? <TxLink chain={chain} hash={intel.launch.liquidityTx} /> : '—'}</dd>
            <dt>Window pools</dt><dd>{w.pools.length ? <ul className="eb-list">{w.pools.map((p) => <li key={p}><AddressLink chain={chain} address={p} /></li>)}</ul> : '—'}</dd>
            <dt>Window</dt><dd>{windowLabel}{intel.coverage.provisional ? ' · provisional' : ''}</dd>
            <dt>Scope</dt><dd>{intel.coverage.scope === 'bounded_first_trade_window' ? 'Bounded first-trade window' : intel.coverage.scope}</dd>
          </dl>
        </div>
        {intel.discovery && <div className="eb-block"><h5>Pool discovery</h5>
          <dl className="eb-kv">
            <dt>Earliest discovered</dt><dd>{intel.discovery.earliestDiscoveredPool ? <AddressLink chain={chain} address={intel.discovery.earliestDiscoveredPool} /> : 'unresolved'}</dd>
            <dt>Earliest verified</dt><dd>{intel.discovery.earliestVerifiedPool ? <AddressLink chain={chain} address={intel.discovery.earliestVerifiedPool} /> : 'unresolved'}</dd>
            <dt>Discovery</dt><dd>{intel.discovery.complete ? 'Complete within selected candidates' : 'Incomplete'}</dd>
          </dl>
          {intel.discovery.candidates.length > 0 && <ul className="eb-list" style={{ marginTop: 8 }}>{intel.discovery.candidates.map((c) => <li key={c.pool}><AddressLink chain={chain} address={c.pool} /> · {DISCOVERY_OUTCOME_LABEL[c.outcome] ?? c.outcome} · {c.reason.split(',').map((r) => reasonLabel(r)).join(' ')} <span className="eb-code">({c.reason})</span></li>)}</ul>}
        </div>}
        {intel.launchDistributions.length > 0 && <div className="eb-block"><h5>Creator launch distributions (not counted as buys)</h5>
          <Expandable items={intel.launchDistributions} initial={LIST_PREVIEW} noun="distributions" className="eb-list" render={(d) => <li key={`${d.txHash}:${d.wallet}`}><AddressLink chain={chain} address={d.wallet} /> · <Amount raw={d.rawAmount} decimals={decimals} symbol={tokenSymbol} /> · <TxLink chain={chain} hash={d.txHash} /></li>} />
        </div>}
        <div className="eb-block"><h5>Coverage codes</h5>
          {codes.length ? <ul className="eb-list">{codes.map((c) => <li key={c}><span className="eb-code">{c}</span> — {reasonLabel(c)}</li>)}</ul> : <p className="eb-note" style={{ margin: 0 }}>None reported. Only the bounded early window is covered.</p>}
        </div>
        <div className="eb-block"><h5>Analysis cost</h5>
          <p style={{ margin: 0 }}>{intel.budget.calls} RPC calls · {intel.budget.cu} estimated CU · {intel.budget.externalRequests ?? 0} external discovery requests; actual provider billing unavailable here.</p>
        </div>
      </div>
    </details>

    <footer className="eb-footer">
      <p>Pool-sourced token delivery is not proof that each recipient paid or coordinated.</p>
      <p>Several recipients in one transaction or one block do not prove common ownership or a bundle. A verified window does not mean every launch buyer was found.</p>
    </footer>
  </div>
}

function RecipientTable({ recipients, chain, decimals, symbol, membership, holdingsRead }: { recipients: EarlyBuyer[]; chain: string; decimals: number | null; symbol: string | null; membership: Map<string, Set<string>>; holdingsRead: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const shown = open ? recipients : recipients.slice(0, TABLE_PREVIEW)
  return <>
    <div className="eb-table-wrap">
      <table className="eb-table" id={id}>
        <caption>Observed pool-sourced recipients in the first-trade window</caption>
        <thead><tr><th scope="col">Recipient</th><th scope="col" className="eb-num">Received in window</th><th scope="col" className="eb-num">Current balance</th><th scope="col">First delivery</th><th scope="col">Evidence</th></tr></thead>
        <tbody>{shown.map((b) => <RecipientRows key={b.wallet} buyer={b} chain={chain} decimals={decimals} symbol={symbol} tags={[...(membership.get(b.wallet.toLowerCase()) ?? [])].sort()} holdingsRead={holdingsRead} />)}</tbody>
      </table>
    </div>
    {recipients.length > TABLE_PREVIEW && <button type="button" className="eb-link-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>{open ? 'Show fewer recipients' : `Show all ${recipients.length} recipients (+${recipients.length - TABLE_PREVIEW})`}</button>}
  </>
}
