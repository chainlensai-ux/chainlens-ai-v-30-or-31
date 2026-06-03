'use client'
import { useEffect, useRef, useState, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────
type NodeType = 'contract' | 'deployer' | 'linked_wallet' | 'holder_wallet'
type RiskLevel = 'low' | 'medium' | 'high' | 'open_check' | 'neutral'
type ConfLevel = 'high' | 'medium' | 'low' | 'open_check'
type EdgeType = 'deployment' | 'transfer_signal' | 'suspicious_transfer' | 'holder_overlap' | 'weak_heuristic'

interface GNode {
  id: string; address: string; label: string
  type: NodeType; confidence: ConfLevel; isCreator: boolean; isLinked: boolean
  supplyPercent: number | null; reasons: string[]
  x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null
  mass: number; radius: number
}
interface GEdge {
  id: string; source: string; target: string
  type: EdgeType; weight: number; confidence: ConfLevel; reason: string
}

// ─── Visual constants ─────────────────────────────────────────────────────────
const RISK_FILL: Record<RiskLevel, string> = {
  low: '#34d399', medium: '#facc15', high: '#fb7185', open_check: '#a855f7', neutral: '#7dd3fc',
}
const ROLE_RING: Record<NodeType, string> = {
  contract: '#7dd3fc', deployer: '#fbbf24', linked_wallet: '#2dd4bf', holder_wallet: '#475569',
}
const EDGE_STROKE: Record<EdgeType, string> = {
  deployment: '#7dd3fc', transfer_signal: '#38bdf8', suspicious_transfer: '#fb7185',
  holder_overlap: '#a855f7', weak_heuristic: '#334155',
}
const CONF_OPACITY: Record<ConfLevel, number> = { high: 1.0, medium: 0.72, low: 0.42, open_check: 0.5 }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hexToRgb(hex: string): string {
  const v = hex.replace('#', '')
  const r = parseInt(v.slice(0, 2), 16)
  const g = parseInt(v.slice(2, 4), 16)
  const b = parseInt(v.slice(4, 6), 16)
  return `${r},${g},${b}`
}
function nodeRadius(pct: number | null): number {
  return Math.max(22, Math.min(56, 22 + Math.sqrt(Math.max(0, pct ?? 0)) * 7))
}
function nodeMass(pct: number | null): number {
  return Math.max(1, Math.min(12, 1 + Math.sqrt(Math.max(0, pct ?? 0)) * 2))
}
function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}
function confToLevel(conf: string | null | undefined): ConfLevel {
  if (conf === 'high') return 'high'
  if (conf === 'medium') return 'medium'
  if (conf === 'low') return 'low'
  return 'open_check'
}
function riskLabel(r: RiskLevel): string {
  return r === 'open_check' ? 'Open check' : r.charAt(0).toUpperCase() + r.slice(1)
}

function deriveRisk(node: GNode, clusterScore: number | null): RiskLevel {
  if (node.type === 'contract') return 'neutral'
  const hasSusp = node.reasons.some(r => /suspicious|repeated|same.?size|funding|control/i.test(r))
  if (hasSusp) return 'high'
  if ((clusterScore ?? 0) > 60) return 'high'
  const pct = node.supplyPercent
  if (pct === null) return 'open_check'
  if (pct >= 10 && (node.isCreator || node.isLinked)) return 'high'
  if (pct >= 5 || (clusterScore ?? 0) >= 21) return 'medium'
  if (pct >= 1) return 'medium'
  return 'low'
}

function nodeRoleLabel(type: NodeType, isCreator: boolean): string {
  if (type === 'contract') return 'Token Contract'
  if (type === 'deployer') return isCreator ? 'Origin Wallet' : 'Possible Deployer'
  if (type === 'linked_wallet') return 'Linked Wallet'
  return 'Indexed Holder'
}

// ─── Physics simulation ───────────────────────────────────────────────────────
function runSimulation(nodes: GNode[], edges: GEdge[], w: number, h: number): void {
  const cx = w / 2; const cy = h / 2
  const n = nodes.length
  const nodeById = new Map<string, GNode>(nodes.map(nd => [nd.id, nd]))

  for (let i = 0; i < n; i++) {
    const nd = nodes[i]
    if (nd.fx !== null) { nd.x = nd.fx; nd.y = nd.fy!; nd.vx = 0; nd.vy = 0; continue }
    const angle = (i / n) * 2 * Math.PI
    const ring = Math.max(80, n * 26)
    nd.x = cx + Math.cos(angle) * ring + (Math.random() - 0.5) * 18
    nd.y = cy + Math.sin(angle) * ring + (Math.random() - 0.5) * 18
    nd.vx = 0; nd.vy = 0
  }

  let alpha = 1
  const alphaDecay = 0.055
  const velDecay = 0.52
  const charge = -220
  const center = 0.06
  const colPad = 12

  for (let iter = 0; iter < 300 && alpha > 0.001; iter++) {
    // Center gravity
    for (const nd of nodes) {
      if (nd.fx !== null) continue
      nd.vx += (cx - nd.x) * center * alpha
      nd.vy += (cy - nd.y) * center * alpha
    }
    // N-body repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i]; const b = nodes[j]
        const dx = b.x - a.x; const dy = b.y - a.y
        const d2 = dx * dx + dy * dy + 0.01
        const invD = 1 / Math.sqrt(d2)
        const f = charge * a.mass * b.mass * alpha / d2
        const fx = dx * invD * f; const fy = dy * invD * f
        if (a.fx === null) { a.vx -= fx / a.mass; a.vy -= fy / a.mass }
        if (b.fx === null) { b.vx += fx / b.mass; b.vy += fy / b.mass }
      }
    }
    // Link springs
    for (const e of edges) {
      const src = nodeById.get(e.source); const tgt = nodeById.get(e.target)
      if (!src || !tgt) continue
      const dx = tgt.x - src.x; const dy = tgt.y - src.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const target = 80 + (100 - e.weight)
      const str = Math.max(0.08, Math.min(1, e.weight / 100)) * alpha
      const delta = ((d - target) / d) * str * 0.5
      const fx = dx * delta; const fy = dy * delta
      if (src.fx === null) { src.vx += fx / src.mass; src.vy += fy / src.mass }
      if (tgt.fx === null) { tgt.vx -= fx / tgt.mass; tgt.vy -= fy / tgt.mass }
    }
    // Collision
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i]; const b = nodes[j]
        const minD = a.radius + b.radius + colPad
        const dx = b.x - a.x; const dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01
        if (d < minD) {
          const overlap = ((minD - d) / d) * 0.5
          const px = dx * overlap; const py = dy * overlap
          if (a.fx === null) { a.x -= px; a.y -= py }
          if (b.fx === null) { b.x += px; b.y += py }
        }
      }
    }
    // Integrate & clamp
    for (const nd of nodes) {
      if (nd.fx !== null) { nd.x = nd.fx; nd.y = nd.fy!; continue }
      nd.vx *= velDecay; nd.vy *= velDecay
      nd.x += nd.vx; nd.y += nd.vy
      const pad = nd.radius + 8
      nd.x = Math.max(pad, Math.min(w - pad, nd.x))
      nd.y = Math.max(pad, Math.min(h - pad, nd.y))
    }
    alpha -= alpha * alphaDecay
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface ClusterMapProps {
  deployerAddress?: string | null
  deployerStatus?: string | null
  linkedWallets?: Array<{ address: string; confidence?: string | null; reason?: string | null }>
  topHolders?: Array<{ address?: string | null; percent?: number | null }>
  supplyControl?: {
    creatorInTopHolders: boolean
    creatorHolderPercent: number | null
    devClusterSupplyPercent: number | null
    matchedLinkedWallets: Array<{ address: string; rank: number; percent: number }>
  } | null
  suspiciousTransfers?: boolean
  suspiciousTransferReasons?: string[]
}

// ─── Component ────────────────────────────────────────────────────────────────
export function ClusterForceGraph({
  deployerAddress, deployerStatus, linkedWallets = [], topHolders = [],
  supplyControl, suspiciousTransfers = false, suspiciousTransferReasons = [],
}: ClusterMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [nodes, setNodes]       = useState<GNode[]>([])
  const [edges, setEdges]       = useState<GEdge[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId]   = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [dims, setDims]         = useState({ w: 600, h: 340 })
  const isTouch = useRef(false)

  useEffect(() => {
    isTouch.current = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 600
      setDims({ w: Math.max(280, width), h: Math.max(260, Math.min(420, width * 0.56)) })
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const { w, h } = dims

    // Supply percent lookup
    const supplyMap = new Map<string, number>()
    if (deployerAddress && supplyControl?.creatorHolderPercent != null)
      supplyMap.set(deployerAddress.toLowerCase(), supplyControl.creatorHolderPercent)
    for (const mw of supplyControl?.matchedLinkedWallets ?? [])
      supplyMap.set(mw.address.toLowerCase(), mw.percent)
    for (const th of topHolders) {
      const addr = (th.address ?? '').toLowerCase()
      if (addr && typeof th.percent === 'number' && !supplyMap.has(addr))
        supplyMap.set(addr, th.percent)
    }

    const newNodes: GNode[] = []
    const seen = new Set<string>()

    // Contract node — fixed top-center
    newNodes.push({
      id: 'contract', address: '', label: 'Contract', type: 'contract',
      confidence: 'high', isCreator: false, isLinked: false,
      supplyPercent: null, reasons: [],
      x: w / 2, y: 70, vx: 0, vy: 0, fx: w / 2, fy: 70,
      mass: 3, radius: 26,
    })
    seen.add('contract')

    // Deployer node
    if (deployerAddress) {
      const al = deployerAddress.toLowerCase()
      const pct = supplyMap.get(al) ?? null
      const conf = deployerStatus === 'confirmed' ? 'high' : deployerStatus === 'possible_match' ? 'medium' : 'low' as ConfLevel
      newNodes.push({
        id: 'deployer', address: deployerAddress, label: shortAddr(deployerAddress),
        type: 'deployer', confidence: conf, isCreator: true, isLinked: false,
        supplyPercent: pct, reasons: [],
        x: w / 2, y: h / 2, vx: 0, vy: 0, fx: null, fy: null,
        mass: nodeMass(pct), radius: nodeRadius(pct),
      })
      seen.add(al)
    }

    // Linked wallet nodes
    for (const lw of linkedWallets) {
      const al = lw.address.toLowerCase()
      if (seen.has(al)) continue
      const pct = supplyMap.get(al) ?? null
      const conf = confToLevel(lw.confidence)
      const hasSusp = suspiciousTransfers && (
        suspiciousTransferReasons.length > 0 ||
        (lw.reason ? /suspicious|repeated|same.?size|funding/i.test(lw.reason) : false)
      )
      newNodes.push({
        id: al, address: lw.address, label: shortAddr(lw.address),
        type: 'linked_wallet', confidence: conf, isCreator: false, isLinked: true,
        supplyPercent: pct,
        reasons: [
          ...(lw.reason ? [lw.reason] : []),
          ...(hasSusp ? ['suspicious_transfer_pattern'] : []),
        ],
        x: w / 2, y: h / 2, vx: 0, vy: 0, fx: null, fy: null,
        mass: nodeMass(pct), radius: nodeRadius(pct),
      })
      seen.add(al)
    }

    // Top holder nodes (skip null/burn, cap at 6)
    let hCount = 0
    for (const th of topHolders) {
      if (hCount >= 6) break
      const addr = (th.address ?? '').toLowerCase()
      if (!addr || seen.has(addr)) continue
      if (/^0x0{38,}$/.test(addr) || /dead/i.test(addr)) continue
      const pct = typeof th.percent === 'number' ? th.percent : null
      newNodes.push({
        id: addr, address: th.address ?? '', label: shortAddr(th.address ?? ''),
        type: 'holder_wallet', confidence: 'open_check', isCreator: false, isLinked: false,
        supplyPercent: pct, reasons: [],
        x: w / 2, y: h / 2, vx: 0, vy: 0, fx: null, fy: null,
        mass: nodeMass(pct), radius: nodeRadius(pct),
      })
      seen.add(addr)
      hCount++
    }

    // Edges
    const newEdges: GEdge[] = []
    if (deployerAddress) {
      const conf: ConfLevel = deployerStatus === 'confirmed' ? 'high' : 'medium'
      newEdges.push({
        id: 'contract-deployer', source: 'contract', target: 'deployer',
        type: 'deployment', weight: deployerStatus === 'confirmed' ? 90 : 60,
        confidence: conf, reason: 'Contract deployment',
      })
    }
    for (const lw of linkedWallets) {
      const al = lw.address.toLowerCase()
      if (!seen.has(al)) continue
      const conf = confToLevel(lw.confidence)
      const hasSusp = suspiciousTransfers && (suspiciousTransferReasons.length > 0 || (lw.reason ? /suspicious|repeated|same.?size|funding/i.test(lw.reason) : false))
      newEdges.push({
        id: `deployer-${al}`,
        source: deployerAddress ? 'deployer' : 'contract',
        target: al,
        type: hasSusp ? 'suspicious_transfer' : 'transfer_signal',
        weight: conf === 'high' ? 80 : conf === 'medium' ? 55 : 30,
        confidence: conf, reason: lw.reason ?? 'Transfer trace',
      })
    }

    // Run simulation (synchronous, settles in ~300 ticks)
    const simNodes = newNodes.map(nd => ({ ...nd }))
    runSimulation(simNodes, newEdges, w, h)
    for (let i = 0; i < newNodes.length; i++) {
      newNodes[i].x = simNodes[i].x
      newNodes[i].y = simNodes[i].y
    }

    setNodes(newNodes)
    setEdges(newEdges)
    setSelectedId(null)
    setHoveredId(null)
    setTooltipPos(null)
  }, [deployerAddress, deployerStatus, JSON.stringify(linkedWallets), JSON.stringify(topHolders), JSON.stringify(supplyControl), suspiciousTransfers, dims.w, dims.h]) // eslint-disable-line react-hooks/exhaustive-deps

  // Derived state
  const selectedNode = nodes.find(n => n.id === selectedId) ?? null
  const hoveredNode  = nodes.find(n => n.id === hoveredId)  ?? null

  const connectedIds: Set<string> | null = selectedId ? new Set(
    edges.filter(e => e.source === selectedId || e.target === selectedId)
         .flatMap(e => [e.source, e.target])
  ) : null

  const clusterRiskScore = supplyControl?.devClusterSupplyPercent != null
    ? Math.min(100, supplyControl.devClusterSupplyPercent * 2)
    : null

  const handleNodeEnter = useCallback((id: string, e: React.MouseEvent) => {
    if (isTouch.current) return
    setHoveredId(id)
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }, [])

  const handleNodeMove = useCallback((e: React.MouseEvent) => {
    if (isTouch.current || !hoveredId) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }, [hoveredId])

  const handleNodeLeave = useCallback(() => {
    setHoveredId(null)
    setTooltipPos(null)
  }, [])

  const handleNodeClick = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedId(prev => prev === id ? null : id)
    setHoveredId(null)
    setTooltipPos(null)
  }, [])

  const { w, h } = dims

  if (nodes.length === 0) {
    return (
      <div style={{ padding: '28px 16px', textAlign: 'center', color: '#475569', fontSize: '11px', fontFamily: 'var(--font-plex-mono)' }}>
        Cluster map builds after a token scan with deployer data.
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>

      {/* ── Graph ─────────────────────────────────────────────── */}
      <svg
        width={w} height={h}
        style={{ display: 'block', overflow: 'visible', cursor: 'default', userSelect: 'none', borderRadius: '12px' }}
        onClick={() => { setSelectedId(null) }}
        onMouseMove={handleNodeMove}
      >
        <defs>
          <radialGradient id="cmap-bg" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="rgba(14,24,43,0.95)" />
            <stop offset="100%" stopColor="rgba(6,10,20,0.98)" />
          </radialGradient>
          {/* Glow filters */}
          <filter id="glow-low"  x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="glow-high" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        <rect width={w} height={h} fill="url(#cmap-bg)" rx={12} />

        {/* Subtle grid lines */}
        <line x1={w * 0.5} y1={0} x2={w * 0.5} y2={h} stroke="rgba(255,255,255,0.02)" strokeWidth={1} />
        <line x1={0} y1={h * 0.5} x2={w} y2={h * 0.5} stroke="rgba(255,255,255,0.02)" strokeWidth={1} />

        {/* ── Edges ─────────────────────────────────────────── */}
        <g>
          {edges.map(edge => {
            const src = nodes.find(n => n.id === edge.source)
            const tgt = nodes.find(n => n.id === edge.target)
            if (!src || !tgt) return null
            const isConn = connectedIds ? (connectedIds.has(edge.source) && connectedIds.has(edge.target)) : null
            const opacity = connectedIds === null
              ? CONF_OPACITY[edge.confidence] * 0.65
              : isConn ? 1.0 : 0.07
            const sw = 1 + (edge.weight / 100) * 2.5 + (isConn ? 1 : 0)
            const color = EDGE_STROKE[edge.type]
            // Slight curve via quadratic bezier
            const mx = (src.x + tgt.x) / 2 - (tgt.y - src.y) * 0.12
            const my = (src.y + tgt.y) / 2 + (tgt.x - src.x) * 0.12
            const isSusp = edge.type === 'suspicious_transfer'
            return (
              <path
                key={edge.id}
                d={`M ${src.x} ${src.y} Q ${mx} ${my} ${tgt.x} ${tgt.y}`}
                stroke={color}
                strokeWidth={sw}
                fill="none"
                opacity={opacity}
                strokeDasharray={edge.type === 'weak_heuristic' ? '5,5' : isSusp ? '3,3' : undefined}
                filter={isConn && isSusp ? 'url(#glow-high)' : undefined}
                style={isSusp ? {
                  animation: 'susp-pulse 2.5s ease-in-out infinite',
                  animationPlayState: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'paused' : 'running',
                } : undefined}
              />
            )
          })}
        </g>

        {/* ── Nodes ─────────────────────────────────────────── */}
        <g>
          {nodes.map(node => {
            const risk     = deriveRisk(node, clusterRiskScore)
            const riskFill = RISK_FILL[risk]
            const roleBorder = ROLE_RING[node.type]
            const isSelected = selectedId === node.id
            const isHovered  = hoveredId === node.id
            const isConn2    = connectedIds ? connectedIds.has(node.id) : true
            const baseOpacity = node.type === 'contract' ? 1 : CONF_OPACITY[node.confidence]
            const opacity = isSelected ? 1 : connectedIds ? (isConn2 ? Math.max(baseOpacity, 0.65) : 0.18) : baseOpacity
            const r = node.radius
            const active = isSelected || isHovered
            const glowFilter = active ? (risk === 'high' ? 'url(#glow-high)' : 'url(#glow-low)') : undefined

            return (
              <g
                key={node.id}
                transform={`translate(${Math.round(node.x)},${Math.round(node.y)})`}
                style={{ cursor: 'pointer' }}
                onClick={e => handleNodeClick(node.id, e)}
                onMouseEnter={e => handleNodeEnter(node.id, e)}
                onMouseLeave={handleNodeLeave}
              >
                {/* Outer glow for active/high-risk */}
                {(active || risk === 'high') && (
                  <circle r={r + 10} fill="none" stroke={riskFill}
                    strokeWidth={isSelected ? 2 : 1}
                    opacity={isSelected ? 0.45 : 0.25}
                    filter={glowFilter}
                  />
                )}
                {/* Role ring */}
                <circle
                  r={r + 4} fill="none"
                  stroke={roleBorder}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                  opacity={opacity * (isSelected ? 0.95 : 0.45)}
                />
                {/* Risk-tinted fill */}
                <circle
                  r={r}
                  fill={`rgba(${hexToRgb(riskFill)},0.10)`}
                  stroke={riskFill}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                  opacity={opacity}
                />
                {/* Supply label inside (if nonzero) */}
                {node.supplyPercent != null && node.supplyPercent > 0 && (
                  <text
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={r > 34 ? 11 : 9}
                    fill={riskFill} fontFamily="var(--font-plex-mono)" fontWeight={700}
                    opacity={opacity}
                    style={{ pointerEvents: 'none' }}
                  >
                    {node.supplyPercent.toFixed(1)}%
                  </text>
                )}
                {/* Contract icon */}
                {node.type === 'contract' && (
                  <text textAnchor="middle" dominantBaseline="middle" fontSize={14}
                    fill={roleBorder} opacity={opacity} style={{ pointerEvents: 'none' }}>
                    ◈
                  </text>
                )}
                {/* Address label below node */}
                <text
                  y={r + 14} textAnchor="middle"
                  fontSize={9} fill="#64748b" fontFamily="var(--font-plex-mono)"
                  opacity={Math.min(opacity * 1.2, 0.9)}
                  style={{ pointerEvents: 'none' }}
                >
                  {node.type === 'contract' ? 'Contract' : node.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      {/* ── Hover tooltip ─────────────────────────────────────── */}
      {tooltipPos && hoveredNode && !isTouch.current && (
        <div style={{
          position: 'absolute',
          left: Math.min(tooltipPos.x + 14, w - 190),
          top: Math.max(tooltipPos.y - 96, 6),
          pointerEvents: 'none',
          zIndex: 20,
          padding: '10px 13px',
          borderRadius: '10px',
          background: 'rgba(6,11,22,0.97)',
          border: `1px solid ${ROLE_RING[hoveredNode.type]}40`,
          backdropFilter: 'blur(8px)',
          minWidth: '172px',
          boxShadow: '0 4px 18px rgba(0,0,0,0.55)',
        }}>
          <div style={{ fontSize: '8px', letterSpacing: '.14em', fontWeight: 700,
            color: ROLE_RING[hoveredNode.type], fontFamily: 'var(--font-plex-mono)', marginBottom: '8px' }}>
            {nodeRoleLabel(hoveredNode.type, hoveredNode.isCreator).toUpperCase()}
          </div>
          {hoveredNode.address && (
            <TooltipRow label="Address" value={hoveredNode.label} />
          )}
          <TooltipRow
            label="Supply"
            value={hoveredNode.supplyPercent != null ? `${hoveredNode.supplyPercent.toFixed(1)}%` : 'Not indexed in this pass'}
          />
          <div style={{ display: 'flex', gap: '14px', marginTop: '2px' }}>
            <TooltipRow label="Risk" value={riskLabel(deriveRisk(hoveredNode, clusterRiskScore))}
              valueColor={RISK_FILL[deriveRisk(hoveredNode, clusterRiskScore)]} />
            <TooltipRow label="Confidence"
              value={hoveredNode.confidence === 'open_check' ? 'Open check' : hoveredNode.confidence.charAt(0).toUpperCase() + hoveredNode.confidence.slice(1)}
              valueColor={hoveredNode.confidence === 'high' ? '#34d399' : hoveredNode.confidence === 'medium' ? '#fbbf24' : '#94a3b8'}
            />
          </div>
        </div>
      )}

      {/* ── Selected wallet detail panel ─────────────────────── */}
      {selectedNode && (
        <SelectedNodePanel
          node={selectedNode}
          clusterRiskScore={clusterRiskScore}
          edges={edges}
          nodes={nodes}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* ── Legend ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px', padding: '0 2px' }}>
        {(['low', 'medium', 'high', 'open_check', 'neutral'] as RiskLevel[]).map(r => (
          <div key={r} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: RISK_FILL[r], display: 'inline-block', flexShrink: 0 }} />
            <span style={{ fontSize: '9px', color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>
              {riskLabel(r)}
            </span>
          </div>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {([['contract', 'Contract'], ['deployer', 'Deployer'], ['linked_wallet', 'Linked'], ['holder_wallet', 'Holder']] as [NodeType, string][]).map(([t, label]) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '10px', height: '2px', background: ROLE_RING[t], display: 'inline-block' }} />
              <span style={{ fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Suspicious edge pulse keyframe */}
      <style>{`
        @keyframes susp-pulse { 0%,100%{opacity:0.5} 50%{opacity:1} }
        @media (prefers-reduced-motion: reduce) { .susp-pulse { animation: none } }
      `}</style>
    </div>
  )
}

// ─── Tooltip row helper ───────────────────────────────────────────────────────
function TooltipRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ marginBottom: '5px' }}>
      <div style={{ fontSize: '8px', color: '#475569', fontFamily: 'var(--font-plex-mono)', marginBottom: '1px' }}>{label}</div>
      <div style={{ fontSize: '10px', color: valueColor ?? '#e2e8f0', fontFamily: 'var(--font-plex-mono)', fontWeight: 600 }}>{value}</div>
    </div>
  )
}

// ─── Selected node panel ──────────────────────────────────────────────────────
function SelectedNodePanel({
  node, clusterRiskScore, edges, nodes, onClose,
}: {
  node: GNode
  clusterRiskScore: number | null
  edges: GEdge[]
  nodes: GNode[]
  onClose: () => void
}) {
  const risk = deriveRisk(node, clusterRiskScore)
  const roleBorder = ROLE_RING[node.type]
  const riskFill = RISK_FILL[risk]

  const connectedEdges = edges.filter(e => e.source === node.id || e.target === node.id)
  const connectedNodes = connectedEdges.map(e => {
    const otherId = e.source === node.id ? e.target : e.source
    return nodes.find(n => n.id === otherId)
  }).filter(Boolean) as GNode[]

  const confLabel = node.confidence === 'open_check' ? 'Open check' : node.confidence.charAt(0).toUpperCase() + node.confidence.slice(1)
  const noSignal = risk === 'neutral' || (risk === 'low' && !node.isCreator && !node.isLinked)

  return (
    <div style={{
      marginTop: '12px',
      padding: '14px 16px',
      borderRadius: '12px',
      border: `1px solid ${roleBorder}28`,
      background: 'rgba(8,14,26,0.85)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '9px', letterSpacing: '.14em', fontWeight: 700, color: roleBorder, fontFamily: 'var(--font-plex-mono)', marginBottom: '4px' }}>
            {nodeRoleLabel(node.type, node.isCreator).toUpperCase()}
          </div>
          <div style={{ fontSize: '11px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)', fontWeight: 600 }}>
            {node.type === 'contract' ? 'Token Contract' : node.label}
          </div>
          {node.address && (
            <div style={{ fontSize: '9px', color: '#475569', fontFamily: 'var(--font-plex-mono)', marginTop: '3px', wordBreak: 'break-all' }}>
              {node.address}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(148,163,184,0.2)', background: 'transparent', color: '#475569', fontSize: '10px', cursor: 'pointer', fontFamily: 'var(--font-plex-mono)', flexShrink: 0 }}
        >
          ✕
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: '8px', marginBottom: '10px' }}>
        {[
          { label: 'Supply', value: node.supplyPercent != null ? `${node.supplyPercent.toFixed(1)}%` : 'Not indexed', color: '#e2e8f0' },
          { label: 'Risk', value: riskLabel(risk), color: riskFill },
          { label: 'Confidence', value: confLabel, color: '#e2e8f0' },
          { label: 'Role', value: nodeRoleLabel(node.type, node.isCreator), color: roleBorder },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(148,163,184,0.1)' }}>
            <div style={{ fontSize: '8px', letterSpacing: '.1em', color: '#475569', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px' }}>{label.toUpperCase()}</div>
            <div style={{ fontSize: '11px', fontWeight: 600, color, fontFamily: 'var(--font-plex-mono)' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Reasons / risk notes */}
      {node.reasons.length > 0 ? (
        <div style={{ padding: '8px 11px', borderRadius: '8px', background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.14)', marginBottom: '10px' }}>
          <div style={{ fontSize: '8px', letterSpacing: '.12em', color: '#f87171', fontFamily: 'var(--font-plex-mono)', marginBottom: '5px', fontWeight: 700 }}>RISK SIGNALS</div>
          {node.reasons.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: '7px', alignItems: 'flex-start', marginBottom: '3px' }}>
              <span style={{ color: '#f87171', flexShrink: 0, fontSize: '9px' }}>›</span>
              <span style={{ fontSize: '10px', color: '#fca5a5', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{r}</span>
            </div>
          ))}
        </div>
      ) : noSignal ? (
        <p style={{ margin: '0 0 10px', fontSize: '10px', color: '#334155', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>
          Neutral holder — no wallet-specific risk signal in this pass.
        </p>
      ) : null}

      {/* Connected edges */}
      {connectedNodes.length > 0 && (
        <div>
          <div style={{ fontSize: '8px', letterSpacing: '.12em', color: '#475569', fontFamily: 'var(--font-plex-mono)', marginBottom: '6px', fontWeight: 700 }}>
            CONNECTIONS ({connectedEdges.length})
          </div>
          <div style={{ display: 'grid', gap: '5px' }}>
            {connectedEdges.map(e => {
              const otherId = e.source === node.id ? e.target : e.source
              const other = nodes.find(n => n.id === otherId)
              if (!other) return null
              const edgeColor2 = EDGE_STROKE[e.type]
              return (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 9px', borderRadius: '7px', background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(148,163,184,0.08)' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: edgeColor2, flexShrink: 0 }} />
                  <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', flex: 1 }}>
                    {other.type === 'contract' ? 'Token Contract' : other.label}
                  </span>
                  <span style={{ fontSize: '9px', color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>{e.reason}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
