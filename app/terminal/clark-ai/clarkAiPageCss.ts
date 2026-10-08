// Clark AI page styles — terminal layout: compact header, one command bar, dense intelligence rows, and a slim
// context/history rail (a drawer below 1180px). Hierarchy comes from spacing, tone and type, not nested boxes;
// glow is reserved for the ready state and the focused composer / send.
export const CLARK_AI_PAGE_CSS = `
        .clk-page {
          --clk-bg:#05080f; --clk-surface:#0a0f1a; --clk-raise:#0d1320; --clk-line:rgba(148,163,184,.10);
          --clk-text:#e6edf7; --clk-muted:#9aa8bc; --clk-faint:#7c8aa1; --clk-cyan:#22d3ee; --clk-violet:#a78bfa;
          --clk-mono: var(--font-plex-mono, ui-monospace, monospace);
          position: relative;
          min-height: 100%;
          overflow-x: hidden;
          color: var(--clk-text);
          background: radial-gradient(70% 220px at 40% 0%, rgba(34,211,238,.05), transparent 70%), var(--clk-bg);
        }
        .clk-shell { position:relative; z-index:1; width:100%; max-width:1600px; margin:0 auto; display:grid; grid-template-columns:minmax(0, 1fr) 272px; align-items:start; }
        .clk-main { min-width:0; padding:20px 28px 40px; }

        /* Header */
        .clk-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
        .clk-head-copy { min-width:0; }
        .clk-title { margin:0; font-size:22px; font-weight:800; letter-spacing:-.02em; line-height:1.15; color:#f8fafc; }
        .clk-title-ai { color:var(--clk-cyan); }
        .clk-subtitle { margin:2px 0 0; color:var(--clk-muted); font-size:13px; }
        .clk-head-side { display:flex; align-items:center; gap:8px; flex-shrink:0; }
        .clk-ready-pill { border:1px solid rgba(45,212,191,.35); border-radius:6px; padding:4px 9px; color:#5eead4; background:rgba(45,212,191,.07); font:700 10.5px var(--clk-mono); letter-spacing:.1em; box-shadow:0 0 14px rgba(45,212,191,.16); }
        .clk-ready-pill--busy { color:#fcd34d; border-color:rgba(245,158,11,.4); background:rgba(245,158,11,.08); box-shadow:0 0 14px rgba(245,158,11,.18); }
        .clk-rail-toggle { display:none; border:1px solid var(--clk-line); border-radius:6px; background:transparent; color:var(--clk-muted); font:600 11px var(--clk-mono); letter-spacing:.04em; padding:5px 9px; cursor:pointer; }
        .clk-rail-toggle:hover { color:var(--clk-text); border-color:rgba(148,163,184,.24); }
        .clk-meta { display:flex; align-items:center; gap:7px; margin-top:8px; color:var(--clk-faint); font:600 11px var(--clk-mono); letter-spacing:.04em; }
        .clk-meta i { font-style:normal; color:#475569; }
        .clk-meta-on { color:#6ee7b7; }

        /* Command bar */
        .clk-console { margin-top:16px; }
        .clk-composer { border:1px solid rgba(34,211,238,.24); border-radius:12px; background:var(--clk-surface); transition:border-color .15s, box-shadow .15s; }
        .clk-composer:focus-within { border-color:rgba(34,211,238,.5); box-shadow:0 0 0 3px rgba(34,211,238,.08), 0 0 24px rgba(34,211,238,.10); }
        .clk-input-row { display:grid; grid-template-columns:auto auto minmax(0, 1fr) 44px; gap:10px; align-items:center; min-height:64px; padding:9px 10px 9px 10px; }
        .clk-seg { display:inline-flex; padding:2px; border-radius:8px; background:rgba(148,163,184,.08); }
        .clk-seg-btn { border:0; border-radius:6px; background:transparent; color:var(--clk-faint); font:700 11.5px var(--font-inter, sans-serif); letter-spacing:.01em; padding:6px 11px; cursor:pointer; transition:background .15s, color .15s; }
        .clk-seg-btn:hover { color:#cbd5e1; }
        .clk-seg-btn--on { background:rgba(34,211,238,.16); color:#a5f3fc; box-shadow:inset 0 0 0 1px rgba(34,211,238,.32); }
        .clk-cmd-btn { width:30px; height:30px; border-radius:7px; border:1px solid var(--clk-line); background:transparent; color:var(--clk-cyan); font:800 14px var(--clk-mono); cursor:pointer; display:grid; place-items:center; }
        .clk-cmd-btn:hover, .clk-cmd-btn--on { background:rgba(34,211,238,.08); border-color:rgba(34,211,238,.32); }
        .clk-cmd-btn:disabled { opacity:.4; cursor:not-allowed; }
        .clk-panel-input { width:100%; min-width:0; background:transparent; border:0; outline:0; color:var(--clk-text); font-size:15px; caret-color:var(--clk-cyan); }
        .clk-panel-input::placeholder { color:#6b7a90; }
        .clk-send-btn { width:44px; height:44px; min-width:44px; min-height:44px; border-radius:9px; border:0; color:#03141a; background:var(--clk-cyan); display:grid; place-items:center; cursor:pointer; transition:background .15s, box-shadow .15s, opacity .15s; }
        .clk-page .clk-send-btn svg { width:16px; height:16px; min-width:0; min-height:0; flex:none; }
        .clk-send-btn:not(:disabled):hover { background:#67e8f9; box-shadow:0 0 18px rgba(34,211,238,.35); }
        .clk-send-btn:disabled { opacity:.28; cursor:not-allowed; }
        .clk-cmd-menu { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:2px; padding:6px; border-top:1px solid var(--clk-line); }
        .clk-cmd-item { display:flex; align-items:baseline; gap:10px; border:0; border-radius:6px; background:transparent; padding:7px 9px; text-align:left; cursor:pointer; }
        .clk-cmd-item:hover, .clk-cmd-item:focus-visible { background:rgba(34,211,238,.07); outline:none; }
        .clk-cmd-name { color:#a5f3fc; font:700 12.5px var(--clk-mono); white-space:nowrap; }
        .clk-cmd-hint { color:var(--clk-faint); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-under { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:10px; }
        .clk-suggest { display:flex; gap:6px; flex-wrap:wrap; min-width:0; }
        .clk-suggest-btn { border:1px solid var(--clk-line); border-radius:7px; background:transparent; color:#c3ccdb; font-size:12px; font-weight:600; padding:5px 10px; cursor:pointer; white-space:nowrap; transition:color .15s, border-color .15s, background .15s; }
        .clk-suggest-btn:hover { color:#e6fbff; border-color:rgba(34,211,238,.35); background:rgba(34,211,238,.05); }
        .clk-suggest-btn:disabled { opacity:.45; cursor:not-allowed; }
        .clk-usage { display:flex; align-items:center; gap:8px; flex-shrink:0; }
        .clk-usage-track { width:64px; height:3px; border-radius:999px; background:rgba(148,163,184,.14); overflow:hidden; }
        .clk-usage-fill { height:100%; border-radius:999px; transition:width .5s; }
        .clk-usage-count { font:600 11px var(--clk-mono); color:var(--clk-faint); white-space:nowrap; }
        .clk-upgrade-note { margin-top:10px; padding:9px 12px; border-left:2px solid #8b5cf6; border-radius:4px; background:rgba(139,92,246,.08); color:#d8ccff; display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; font-size:12.5px; }
        .clk-upgrade-link { color:#ede9fe; text-decoration:none; font-weight:700; }

        /* Thread */
        .clk-console--thread .clk-composer { margin-top:10px; }
        .clk-thread { min-height:240px; max-height:calc(100vh - 330px); overflow-y:auto; display:flex; flex-direction:column; gap:12px; padding:2px 2px 8px; }
        .clk-thread-top { display:flex; justify-content:flex-end; }
        .clk-clear-btn { border:0; background:transparent; color:var(--clk-faint); cursor:pointer; font:600 11px var(--clk-mono); letter-spacing:.03em; }
        .clk-clear-btn:hover { color:#cbd5e1; }
        .clk-msg { max-width:min(86%, 760px); padding:11px 14px; border-radius:10px; background:var(--clk-raise); }
        .clk-msg--user { align-self:flex-end; background:rgba(34,211,238,.09); }
        .clk-msg--clark { align-self:flex-start; background:transparent; border-left:2px solid rgba(45,212,191,.45); border-radius:0 10px 10px 0; padding-left:14px; }
        .clk-msg-role { display:flex; gap:8px; align-items:center; margin-bottom:5px; color:#67e8f9; font:700 10.5px var(--clk-mono); letter-spacing:.08em; text-transform:uppercase; }
        .clk-msg-role::after { content:attr(data-intent); color:var(--clk-faint); font-weight:500; letter-spacing:0; text-transform:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-msg-text { margin:0; font-size:15px; line-height:1.55; color:#e8eef7; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
        .clk-intent-badge { display:inline-flex; width:max-content; margin:0 0 8px; padding:3px 7px; border-radius:4px; color:#67e8f9; background:rgba(45,212,191,.1); font:700 10px var(--clk-mono); letter-spacing:.1em; text-transform:uppercase; }
        .clk-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
        .clk-action { border:1px solid rgba(45,212,191,.24); border-radius:7px; padding:6px 10px; color:#ccfbf1; background:rgba(45,212,191,.05); font-size:12.5px; font-weight:600; text-decoration:none; }
        .clk-action:hover { background:rgba(45,212,191,.11); }
        .clk-action--disabled { opacity:.45; cursor:not-allowed; pointer-events:none; }
        .clk-action--btn { cursor:pointer; font-family:inherit; }
        .clk-thinking { display:flex; align-items:center; gap:12px; min-width:0; flex-wrap:wrap; }
        .clk-thinking-stage { color:#dbeafe; font:700 12.5px var(--clk-mono); letter-spacing:.04em; }

        /* Empty state */
        .clk-empty { margin-top:22px; }
        .clk-empty-title { margin:0; color:#f1f5f9; font-size:15px; font-weight:700; }
        .clk-empty-text { margin:2px 0 10px; color:var(--clk-muted); font-size:13px; }
        .clk-examples { display:flex; flex-direction:column; align-items:flex-start; gap:2px; }
        .clk-example { display:inline-flex; align-items:center; gap:9px; border:0; border-radius:6px; background:transparent; color:#cbd5e1; font-size:13.5px; padding:5px 8px 5px 0; cursor:pointer; text-align:left; transition:color .15s; }
        .clk-example span { color:var(--clk-cyan); opacity:.7; transition:transform .15s, opacity .15s; }
        .clk-example:hover { color:#f0fdff; }
        .clk-example:hover span { opacity:1; transform:translateX(2px); }

        /* Recent intelligence */
        .clk-intel { margin-top:24px; }
        .clk-section-label { margin:0 0 6px; color:var(--clk-faint); font:700 10.5px var(--clk-mono); letter-spacing:.12em; text-transform:uppercase; }
        .clk-intel-rows { border-top:1px solid var(--clk-line); }
        .clk-intel-row { display:grid; grid-template-columns:68px minmax(0, 1fr) auto auto; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid var(--clk-line); font-size:13px; }
        .clk-intel-main { color:var(--clk-text); font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--clk-mono); font-size:12.5px; }
        .clk-intel-num { font:700 12px var(--clk-mono); }
        .clk-up { color:#34d399; } .clk-down { color:#f87171; }
        .clk-intel-meta { color:var(--clk-faint); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:260px; }
        .clk-intel-row--empty .clk-intel-main { color:#7c8aa1; font-family:inherit; font-weight:500; font-size:13px; }
        .clk-tag { justify-self:start; padding:2px 6px; border-radius:4px; font:700 9.5px var(--clk-mono); letter-spacing:.1em; text-transform:uppercase; }
        .clk-tag--token { color:#67e8f9; background:rgba(34,211,238,.1); }
        .clk-tag--wallet { color:#c4b5fd; background:rgba(167,139,250,.12); }
        .clk-tag--market { color:#6ee7b7; background:rgba(52,211,153,.1); }
        .clk-intel-row--empty .clk-tag { opacity:.6; }

        /* Context rail */
        .clk-side { position:sticky; top:0; max-height:100vh; overflow-y:auto; display:flex; flex-direction:column; gap:18px; padding:20px 26px 24px 18px; border-left:1px solid var(--clk-line); background:rgba(7,11,20,.6); }
        .clk-rail-drawer-head { display:none; }
        .clk-rail-block { min-width:0; }
        .clk-rail-block--history { padding-top:16px; border-top:1px solid var(--clk-line); }
        .clk-rail-title { margin:0 0 10px; color:var(--clk-faint); font:700 10.5px var(--clk-mono); letter-spacing:.12em; text-transform:uppercase; }
        .clk-ctx { display:grid; grid-template-columns:56px minmax(0, 1fr); gap:7px 10px; margin:0; }
        .clk-ctx dt { color:var(--clk-faint); font:600 11px var(--clk-mono); }
        .clk-ctx dd { margin:0; color:#e2e8f0; font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-rail-scrim { display:none; }

        /* Narrower desktop: the rail becomes a drawer; the workspace keeps the full width. */
        @media (max-width: 1180px) {
          .clk-shell { grid-template-columns:minmax(0, 1fr); }
          .clk-rail-toggle { display:inline-flex; }
          .clk-side { position:fixed; top:0; right:0; bottom:0; z-index:60; width:min(320px, 88vw); max-height:none; background:#070b14; border-left:1px solid rgba(148,163,184,.16); box-shadow:-24px 0 48px rgba(0,0,0,.45); transform:translateX(100%); transition:transform .2s ease; visibility:hidden; }
          .clk-side--open { transform:translateX(0); visibility:visible; }
          .clk-rail-drawer-head { display:flex; align-items:center; justify-content:space-between; color:var(--clk-muted); font:700 11px var(--clk-mono); letter-spacing:.08em; text-transform:uppercase; }
          .clk-rail-drawer-head button { border:0; background:transparent; color:var(--clk-muted); font-size:14px; cursor:pointer; min-width:32px; min-height:32px; }
          .clk-rail-scrim { display:block; position:fixed; inset:0; z-index:59; border:0; background:rgba(2,4,10,.55); cursor:pointer; }
        }
        /* The terminal's fixed mobile menu button sits top-left below 1024px (its shared spacer is disabled
           globally), so the Clark header reserves that space itself. */
        @media (max-width: 1023px) { .clk-main { padding-top:60px; } }
        @media (max-width: 780px) {
          .clk-main { padding:60px 14px 96px; }
          .clk-head { flex-direction:column; gap:8px; }
          .clk-input-row { grid-template-columns:auto minmax(0, 1fr) 44px; row-gap:8px; }
          .clk-seg { grid-column:1 / -1; justify-self:start; }
          .clk-under { flex-direction:column; align-items:stretch; gap:8px; }
          .clk-suggest { flex-wrap:nowrap; overflow-x:auto; padding-bottom:2px; }
          .clk-usage { justify-content:flex-end; }
          .clk-msg { max-width:100%; }
          .clk-intel-row { grid-template-columns:60px minmax(0, 1fr) auto; }
          .clk-intel-meta { display:none; }
          .clk-thread { max-height:none; min-height:0; }
        }
        @media (max-width: 480px) { .clk-title { font-size:20px; } .clk-rail-toggle { padding:5px 7px; } }
        @media (prefers-reduced-motion: reduce) { .clk-side, .clk-example span { transition:none; } }
      `
