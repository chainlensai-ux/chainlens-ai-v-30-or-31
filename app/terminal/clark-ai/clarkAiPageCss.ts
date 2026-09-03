export const CLARK_AI_PAGE_CSS = `
        .clk-page {
          position: relative;
          min-height: 100%;
          overflow-x: hidden;
          color: #e5edf8;
          background:
            radial-gradient(circle at 78% 10%, rgba(76, 29, 149, .22), transparent 30%),
            radial-gradient(circle at 18% 2%, rgba(20, 184, 166, .13), transparent 28%),
            linear-gradient(180deg, #020611 0%, #050914 46%, #02040b 100%);
        }
        .clk-grid { position:absolute; inset:0; pointer-events:none; background-image: linear-gradient(rgba(34,211,238,.028) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.028) 1px, transparent 1px), radial-gradient(rgba(148,163,184,.08) 1px, transparent 1.4px); background-size: 36px 36px, 36px 36px, 18px 18px; mask-image: radial-gradient(ellipse 60% 40% at 58% 5%, black 0%, transparent 76%); }
        .clk-glow { position:absolute; pointer-events:none; inset:0; background: radial-gradient(circle at 73% 12%, rgba(34,211,238,.08), transparent 20%), radial-gradient(circle at 88% 30%, rgba(168,85,247,.08), transparent 24%), radial-gradient(circle at 8% 60%, rgba(45,212,191,.04), transparent 30%); }
        .clk-shell { position:relative; z-index:1; width:100%; max-width: 1560px; margin:0 auto; padding: 28px 28px 48px; display:grid; grid-template-columns: minmax(0, 1fr) 360px; gap:24px; align-items:start; }
        .clk-main { min-width:0; }
        .clk-hero { display:flex; flex-direction:column; gap:11px; padding: 4px 0 16px; border-bottom:1px solid rgba(148,163,184,.1); }
        .clk-title-row { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
        .clk-title { margin:0; font-size: clamp(34px, 3.1vw, 46px); font-weight: 850; letter-spacing:-.04em; line-height:.98; color:#f8fafc; }
        .clk-title-ai { background: linear-gradient(110deg, #22d3ee 10%, #7c3aed 58%, #c084fc 96%); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
        .clk-ready-pill { border:1px solid rgba(45,212,191,.32); border-radius:999px; padding:6px 14px; color:#5eead4; background:rgba(6,20,30,.6); font:700 11px var(--font-plex-mono, monospace); letter-spacing:.10em; }
        .clk-subtitle { margin:0; color:#8b99ae; font-size:15px; line-height:1.55; }
        .clk-status-row { display:flex; align-items:center; flex-wrap:wrap; gap:16px; margin-top:3px; }
        .clk-status-chip { display:inline-flex; align-items:center; gap:6px; color:#8b99ae; font:700 11.5px var(--font-plex-mono, monospace); letter-spacing:.04em; white-space:nowrap; }
        .clk-status-dot { width:5px; height:5px; border-radius:999px; flex-shrink:0; }
        .clk-actions-row { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; margin:18px 0 20px; }
        .clk-quick-card { position:relative; height:100%; text-align:left; display:flex; gap:13px; align-items:center; border:1px solid rgba(148,163,184,.14); border-radius:13px; background:rgba(9,15,28,.6); padding:17px 18px; color:#f8fafc; cursor:pointer; transition: border-color .15s, background .15s, transform .15s; overflow:hidden; }
        .clk-quick-card:hover { border-color: color-mix(in srgb, var(--accent) 45%, rgba(148,163,184,.3)); background:rgba(13,21,38,.78); transform: translateY(-1px); }
        .clk-quick-icon { width:32px; height:32px; border-radius:9px; display:grid; place-items:center; font-size:16px; border:1px solid color-mix(in srgb, var(--accent) 55%, rgba(255,255,255,.08)); color:var(--accent); background: color-mix(in srgb, var(--accent) 12%, rgba(2,6,23,.7)); flex:0 0 auto; }
        .clk-quick-copy { display:flex; min-width:0; flex:1 1 auto; flex-direction:column; justify-content:center; gap:2px; }
        .clk-quick-title { display:block; margin:0; font-weight:750; font-size:14px; line-height:1.3; letter-spacing:-.005em; white-space:normal; overflow-wrap:break-word; }
        .clk-quick-sub { display:block; margin:0; color:#7c8aa1; font-size:11.5px; font-weight:600; line-height:1.4; white-space:normal; overflow-wrap:break-word; }
        .clk-console { border:1px solid rgba(59,130,246,.14); border-radius:16px; background:rgba(6,11,22,.7); overflow:hidden; }
        .clk-tabs { display:flex; align-items:center; gap:6px; padding:13px 18px; border-bottom:1px solid rgba(148,163,184,.1); }
        .clk-tab { min-height:0; border:1px solid transparent; border-radius:8px; background:transparent; color:#7f8ea3; font-weight:700; font-size:12.5px; letter-spacing:.01em; cursor:pointer; padding:7px 15px; display:flex; gap:7px; align-items:center; justify-content:center; transition:background .15s, color .15s, border-color .15s; }
        .clk-tab:hover { color:#c3ccdb; }
        .clk-tab--active { color:#67e8f9; background:rgba(34,211,238,.09); border-color:rgba(34,211,238,.22); }
        .clk-tab svg { width:15px; height:15px; }
        .clk-thread { position:relative; min-height:0; max-height:640px; overflow-y:auto; padding:20px 24px 14px; display:flex; flex-direction:column; gap:14px; background-image: linear-gradient(rgba(34,211,238,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.014) 1px, transparent 1px); background-size:32px 32px, 32px 32px; }
        .clk-thread-top { display:flex; justify-content:flex-end; min-height:0; }
        .clk-clear-btn { border:0; background:transparent; color:#71809a; cursor:pointer; font-size:11.5px; font-weight:600; }
        .clk-clear-btn:hover { color:#98a6ba; }
        .clk-intro--empty { display:flex; flex-direction:column; align-items:flex-start; width:100%; padding:22px 22px 8px; gap:16px; }
        .clk-intro-title { color:#d3dae6; font-weight:700; font-size:14.5px; margin:0; }
        .clk-intro-text { margin:0; color:#8391a7; line-height:1.5; font-size:13px; max-width:560px; }
        .clk-start-with { width:100%; }
        .clk-start-with-label { display:block; margin-bottom:9px; color:#5b6b84; font:750 10px var(--font-plex-mono, monospace); letter-spacing:.10em; text-transform:uppercase; }
        .clk-start-with-row { display:flex; flex-wrap:wrap; gap:9px; }
        .clk-start-chip { border:1px solid rgba(34,211,238,.2); border-radius:9px; background:rgba(34,211,238,.04); color:#a7e8f5; font-weight:700; font-size:12.5px; padding:9px 14px; cursor:pointer; transition:border-color .15s, background .15s, color .15s; }
        .clk-start-chip:hover { border-color:rgba(45,212,191,.45); background:rgba(45,212,191,.09); color:#ccfbf1; }
        .clk-msg { max-width:min(84%, 680px); padding:14px 17px; border-radius:16px; border:1px solid rgba(148,163,184,.13); background:linear-gradient(145deg, rgba(13,22,38,.92), rgba(6,11,24,.88)); box-shadow:0 14px 30px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.05); }
        .clk-msg--user { align-self:flex-end; border-color:rgba(34,211,238,.22); border-bottom-right-radius:6px; background:linear-gradient(145deg, rgba(9,44,55,.82), rgba(7,24,34,.76)); }
        .clk-msg--clark { align-self:flex-start; border-color:rgba(45,212,191,.18); border-bottom-left-radius:6px; }
        .clk-msg-role { display:flex; gap:8px; align-items:center; margin-bottom:6px; color:#67e8f9; font:750 11px var(--font-inter, sans-serif); letter-spacing:.04em; text-transform:uppercase; }
        .clk-msg-role::after { content:attr(data-intent); color:#7c8aa1; font-weight:600; letter-spacing:0; text-transform:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.72; }
        .clk-msg-text { margin:0; font-size:15.5px; line-height:1.5; color:#e1e9f5; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
        .clk-intent-badge { display:inline-flex; width:max-content; margin:0 0 9px; padding:5px 10px; border:1px solid rgba(45,212,191,.28); border-radius:999px; color:#67e8f9; background:rgba(45,212,191,.08); font-size:10.5px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
        .clk-actions { display:flex; flex-wrap:wrap; gap:9px; margin-top:12px; }
        .clk-action { border:1px solid rgba(45,212,191,.25); border-radius:999px; padding:8px 13px; color:#ccfbf1; background:rgba(45,212,191,.07); font-size:12.5px; font-weight:700; text-decoration:none; }
        .clk-action--disabled { opacity:.45; cursor:not-allowed; pointer-events:none; }
        .clk-action--btn { cursor:pointer; font-family:inherit; }
        .clk-thinking { display:flex; align-items:center; gap:14px; min-width:0; flex-wrap:wrap; }
        .clk-thinking-stage { color:#dbeafe; font:800 13px var(--font-plex-mono, monospace); letter-spacing:.04em; transition:opacity .2s; }
        .clk-scanline { position:relative; height:2px; margin-top:10px; overflow:hidden; background:rgba(148,163,184,.12); }
        .clk-scanline::before { content:''; position:absolute; inset:0 auto 0 0; width:42%; background:linear-gradient(90deg, transparent, rgba(45,212,191,.9), transparent); animation:clkScan 1.15s linear infinite; }
        @keyframes clkScan { from{ transform:translateX(-100%);} to{ transform:translateX(260%);} }
        .clk-command { margin:16px 22px 0; }
        .clk-command-label { display:block; margin:0 0 5px; color:#5eead4; font:800 10px var(--font-plex-mono, monospace); letter-spacing:.14em; text-transform:uppercase; }
        .clk-command-line { margin:0; color:#8b99ae; font-size:12.5px; line-height:1.45; }
        .clk-input-wrap { margin:14px 22px 16px; border:1px solid rgba(34,211,238,.32); border-radius:15px; background:rgba(3,9,20,.9); transition:border-color .15s; }
        .clk-input-wrap:focus-within { border-color:rgba(34,211,238,.55); }
        .clk-input-row { display:grid; grid-template-columns:42px minmax(0, 1fr) auto 48px; gap:12px; align-items:center; min-height:68px; padding:9px 12px 9px 14px; }
        .clk-prompt-mark { height:38px; border-radius:10px; display:grid; place-items:center; color:#22d3ee; font:900 16px var(--font-plex-mono, monospace); background:rgba(34,211,238,.06); border:1px solid rgba(34,211,238,.16); }
        .clk-panel-input { width:100%; background:transparent; border:0; outline:0; color:#e5edf8; font-size:15.5px; caret-color:#22d3ee; }
        .clk-panel-input::placeholder { color:#647087; font-size:14px; }
        .clk-helper { color:#5e6c82; font-size:11px; white-space:nowrap; }
        .clk-send-btn { width:44px; height:44px; min-width:44px; min-height:44px; border-radius:10px; border:1px solid rgba(34,211,238,.45); color:#67e8f9; background:rgba(34,211,238,.08); display:grid; place-items:center; cursor:pointer; transition:border-color .15s, background .15s; }
        .clk-send-btn:not(:disabled):hover { background:rgba(34,211,238,.14); border-color:rgba(94,234,212,.6); }
        .clk-send-btn:disabled { opacity:.35; cursor:not-allowed; }
        .clk-upgrade-note { margin:0 22px 14px; padding:13px 16px; border:1px solid rgba(139,92,246,.28); border-radius:13px; background:rgba(139,92,246,.08); color:#c4b5fd; display:flex; justify-content:space-between; flex-wrap:wrap; gap:12px; font-size:13.5px; }
        .clk-upgrade-link { color:#e9d5ff; text-decoration:none; font-weight:800; }
        .clk-usage { display:flex; align-items:center; gap:12px; padding:0 22px 18px; }
        .clk-usage-label, .clk-usage-count { font:700 11px var(--font-plex-mono, monospace); color:#61708a; white-space:nowrap; }
        .clk-usage-track { flex:1; height:4px; border-radius:999px; background:rgba(148,163,184,.11); overflow:hidden; }
        .clk-usage-fill { height:100%; border-radius:999px; transition:width .5s; }
        .clk-intel { margin-top:20px; }
        .clk-intel-head { margin:0 0 12px; }
        .clk-intel-title { margin:0; color:#f1f5f9; font-size:16px; font-weight:800; letter-spacing:-.01em; }
        .clk-intel-desc { margin:4px 0 0; color:#8391a7; font-size:12.5px; }
        .clk-intel-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:13px; }
        .clk-intel-card { position:relative; min-height:0; height:100%; display:flex; flex-direction:column; border:1px solid rgba(148,163,184,.14); border-radius:13px; background:linear-gradient(145deg, rgba(12,20,36,.82), rgba(5,10,22,.9)); padding:16px 17px; box-shadow: inset 0 1px 0 rgba(255,255,255,.045); overflow:hidden; }
        .clk-intel-card:not(.clk-intel-card--empty) { border-color: color-mix(in srgb, var(--accent) 38%, rgba(148,163,184,.2)); }
        .clk-intel-icon { display:inline-flex; width:26px; height:26px; border-radius:8px; align-items:center; justify-content:center; margin-bottom:10px; font-size:14px; color: var(--accent, #94a3b8); border:1px solid color-mix(in srgb, var(--accent, #475569) 45%, transparent); background: color-mix(in srgb, var(--accent, #475569) 10%, transparent); flex:0 0 auto; }
        .clk-intel-card--empty .clk-intel-icon { color:#7c8aa1; border-color:rgba(148,163,184,.22); background:rgba(148,163,184,.06); }
        .clk-intel-label { color:#e7edf6; font-weight:700; font-size:13.5px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-intel-card--empty .clk-intel-label { color:#9aa8bb; }
        .clk-intel-sub { color:#94a3b8; font-size:12px; line-height:1.45; margin:5px 0 0; white-space:normal; word-break:break-word; }
        .clk-intel-empty-row { border:1px dashed rgba(148,163,184,.18); border-radius:13px; background:rgba(148,163,184,.03); padding:17px 19px; color:#8391a7; font-size:13.5px; line-height:1.55; }
        .clk-side { display:flex; flex-direction:column; gap:16px; }
        .clk-side-card { border:1px solid rgba(148,163,184,.1); border-radius:14px; background:rgba(7,13,25,.6); padding:17px; }
        .clk-side-title { display:flex; align-items:center; gap:9px; margin:0 0 12px; padding-bottom:10px; border-bottom:1px solid rgba(148,163,184,.08); color:#dbe4f0; font-size:12px; font-weight:800; letter-spacing:.02em; text-transform:uppercase; }
        .clk-side-title svg { width:15px; height:15px; color:#22d3ee; }
        .clk-context-row { padding:0 0 9px; margin-bottom:9px; border-bottom:0; }
        .clk-context-row:last-child { margin-bottom:0; padding-bottom:0; }
        .clk-context-label { color:#7f8ea3; font:700 9.5px var(--font-plex-mono, monospace); letter-spacing:.08em; text-transform:uppercase; margin-bottom:4px; }
        .clk-context-value { color:#e5edf8; font-size:13.5px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-context-sub { color:#6d7c94; font-size:11px; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-empty { margin:0; color:#7c8aa1; font-size:13px; line-height:1.55; padding:12px; border:1px dashed rgba(148,163,184,.16); border-radius:11px; background:rgba(148,163,184,.03); }
        @media (max-width: 1100px) { .clk-shell { grid-template-columns:1fr; } .clk-side { display:flex; flex-direction:column; } }
        @media (max-width: 780px) { .clk-shell { padding:12px 14px 96px; } .clk-actions-row { grid-template-columns:1fr 1fr; } .clk-side { display:flex; flex-direction:column; } .clk-thread { min-height:0; padding:18px 16px 12px; } .clk-input-row { grid-template-columns:40px minmax(0,1fr) 48px; min-height:66px; } .clk-helper { display:none; } .clk-intel-grid { grid-template-columns:1fr 1fr; } .clk-msg { max-width:100%; } }
        /* MOBILE SECTION SEPARATION, DISCLOSED (requested: "make sure it all fits and is sized well
           for mobile"): .clk-intel (Recent Intelligence, end of .clk-main) and .clk-side's own cards
           (Context, Chat History) are translucent (rgba backgrounds around 60% opacity) and stack
           with only the shell's own row-gap between them once the layout collapses to one column —
           on a narrow, short mobile viewport that reads as one card bleeding into the next instead of
           two clearly separate sections. More opaque backgrounds + explicit top spacing keep every
           section legibly boundaried at small sizes without changing the desktop layout at all. */
        @media (max-width: 1100px) {
          .clk-intel { margin-top:18px; }
          .clk-side { margin-top:8px; gap:18px; }
          .clk-side-card, .clk-intel-card, .clk-intel-empty-row { background-color:rgba(6,11,22,.92) !important; }
        }
        @media (max-width: 480px) { .clk-actions-row { grid-template-columns:1fr; } .clk-title { font-size:28px; } .clk-ready-pill { padding:5px 10px; } .clk-intel-grid { grid-template-columns:1fr; } }
      `
