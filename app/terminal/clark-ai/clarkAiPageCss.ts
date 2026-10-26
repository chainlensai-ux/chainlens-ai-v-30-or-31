// Clark AI page styles — a full-height workspace: slim header, a centred conversation column that
// scrolls on its own, a composer docked at the bottom, and a slim history/context rail on the right
// (a drawer below 1180px). Near-black page, graphite surfaces, silver-grey lines; mint is kept for
// primary actions and CORTEX indicators. Reply typography (.clk-r-*) belongs to components/ClarkReply.
export const CLARK_AI_PAGE_CSS = `
        .clk-page {
          --clk-bg:#050607; --clk-surface:#0d0f11; --clk-raise:#14171a; --clk-raise-2:#1a1d21;
          --clk-line:rgba(170,176,182,.11); --clk-line-2:rgba(170,176,182,.2);
          --clk-text:#e8ebee; --clk-muted:#a4a9ae; --clk-faint:#80858a; --clk-mint:#1fd6dc; --clk-mint-soft:#7ee9ec;
          --clk-risk:#f87171; --clk-caution:#fbbf24; --clk-ok:#5eead4;
          --clk-mono: var(--font-plex-mono, ui-monospace, monospace);
          --clk-ease: cubic-bezier(.2,.7,.2,1);
          position: relative;
          /* The terminal layout lets its scroll container grow with content, so the workspace pins
             itself to the viewport: the transcript scrolls inside and the composer stays docked. */
          height: 100vh;
          height: 100dvh;
          min-height: 0;
          overflow: hidden;
          color: var(--clk-text);
          background: var(--clk-bg);
        }
        .clk-shell { position:relative; height:100%; min-height:0; display:grid; grid-template-columns:minmax(0, 1fr) 264px; }
        .clk-main { min-width:0; min-height:0; height:100%; display:flex; flex-direction:column; }

        /* Header */
        .clk-head { flex:none; display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:56px; padding:10px 28px; border-bottom:1px solid var(--clk-line); }
        .clk-head-copy { display:flex; align-items:center; gap:12px; min-width:0; }
        .clk-title { margin:0; font-size:17px; font-weight:750; letter-spacing:-.015em; line-height:1.2; color:#f4f6f8; white-space:nowrap; }
        .clk-title-ai { color:var(--clk-mint); }
        .clk-status { display:inline-flex; align-items:center; gap:7px; color:var(--clk-muted); font:600 10.5px var(--clk-mono); letter-spacing:.12em; text-transform:uppercase; white-space:nowrap; }
        .clk-status i { width:6px; height:6px; border-radius:50%; background:var(--clk-mint); box-shadow:0 0 0 3px rgba(31,214,220,.12); }
        .clk-status--busy i { background:var(--clk-caution); box-shadow:0 0 0 3px rgba(251,191,36,.14); animation:clkPulse 1.2s ease-in-out infinite; }
        @keyframes clkPulse { 50% { opacity:.35; } }
        .clk-head-side { display:flex; align-items:center; gap:10px; flex-shrink:0; }
        .clk-head-btn { display:inline-flex; align-items:center; gap:6px; height:30px; border:1px solid var(--clk-line); border-radius:8px; background:transparent; color:var(--clk-muted); font-size:12px; font-weight:600; padding:0 10px; cursor:pointer; transition:color .15s, border-color .15s, background .15s; }
        .clk-head-btn:hover { color:var(--clk-text); border-color:var(--clk-line-2); background:rgba(255,255,255,.02); }
        .clk-rail-toggle { display:none; }
        .clk-usage { display:flex; align-items:center; gap:8px; }
        .clk-usage-track { width:56px; height:3px; border-radius:999px; background:rgba(170,176,182,.14); overflow:hidden; }
        .clk-usage-fill { height:100%; border-radius:999px; transition:width .4s var(--clk-ease); }
        .clk-usage-count { font:600 11px var(--clk-mono); color:var(--clk-faint); white-space:nowrap; }

        /* Scroll area: welcome or transcript */
        .clk-scroll { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:28px 28px 16px; }
        .clk-scroll--welcome { display:flex; }

        /* Welcome */
        .clk-welcome { margin:auto; width:100%; max-width:640px; text-align:center; padding:24px 0; animation:clkIn .25s var(--clk-ease); }
        .clk-cortex-tag { display:inline-flex; align-items:center; gap:7px; padding:4px 10px; border:1px solid rgba(31,214,220,.22); border-radius:999px; color:var(--clk-mint-soft); background:rgba(31,214,220,.05); font:700 10px var(--clk-mono); letter-spacing:.16em; }
        .clk-cortex-tag i { width:5px; height:5px; border-radius:50%; background:var(--clk-mint); }
        .clk-welcome-title { margin:18px 0 8px; font-size:clamp(22px, 2.4vw, 28px); font-weight:700; letter-spacing:-.02em; line-height:1.2; color:#f4f6f8; }
        .clk-welcome-text { margin:0 auto; max-width:460px; color:var(--clk-muted); font-size:14px; line-height:1.6; }
        .clk-welcome-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px; margin-top:28px; text-align:left; }
        .clk-welcome-btn { display:flex; flex-direction:column; align-items:flex-start; gap:3px; text-align:left; min-height:60px; padding:11px 14px; border:1px solid var(--clk-line); border-radius:12px; background:var(--clk-surface); cursor:pointer; transition:border-color .15s, background .15s; }
        .clk-welcome-btn:hover:not(:disabled) { border-color:rgba(31,214,220,.32); background:var(--clk-raise); }
        .clk-welcome-btn:focus-visible { outline:2px solid rgba(31,214,220,.55); outline-offset:2px; }
        .clk-welcome-btn:disabled { opacity:.45; cursor:not-allowed; }
        .clk-welcome-btn-label { color:#eef1f3; font-size:13.5px; font-weight:650; }
        .clk-welcome-btn-hint { color:var(--clk-faint); font-size:12px; line-height:1.4; }
        @keyframes clkIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }

        /* Transcript */
        .clk-thread { width:100%; max-width:780px; margin:0 auto; display:flex; flex-direction:column; gap:26px; }
        .clk-msg { display:flex; min-width:0; animation:clkIn .18s var(--clk-ease); }
        .clk-msg--user { justify-content:flex-end; }
        .clk-bubble { max-width:min(78%, 600px); padding:10px 14px; border-radius:14px 14px 4px 14px; background:var(--clk-raise-2); border:1px solid var(--clk-line); color:#eef1f3; font-size:14.5px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; }
        .clk-msg--clark { gap:12px; align-items:flex-start; }
        .clk-avatar { flex:none; width:26px; height:26px; margin-top:1px; border-radius:8px; display:grid; place-items:center; border:1px solid rgba(31,214,220,.28); background:rgba(31,214,220,.07); color:var(--clk-mint); font:800 12px var(--font-inter, sans-serif); }
        .clk-msg-body { flex:1; min-width:0; }
        .clk-msg-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-height:26px; margin-bottom:4px; }
        .clk-msg-name { color:#f1f3f5; font-size:13px; font-weight:700; }
        .clk-intent-badge { padding:2px 7px; border-radius:5px; border:1px solid var(--clk-line); color:var(--clk-muted); font:650 10px var(--clk-mono); letter-spacing:.08em; text-transform:uppercase; }
        .clk-msg-flag { padding:2px 7px; border-radius:5px; color:#fecaca; background:rgba(248,113,113,.1); font:650 10px var(--clk-mono); letter-spacing:.06em; text-transform:uppercase; }
        .clk-msg--error .clk-msg-body { border-left:2px solid rgba(248,113,113,.45); padding-left:12px; }
        .clk-msg--stopped .clk-r-p { color:var(--clk-faint); }
        .clk-thinking { display:flex; align-items:center; gap:10px; min-height:28px; }
        .clk-thinking-stage { color:var(--clk-muted); font-size:13px; }
        .clk-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
        .clk-action { display:inline-flex; align-items:center; gap:6px; min-height:30px; border:1px solid rgba(31,214,220,.22); border-radius:8px; padding:5px 11px; color:#d6f8f9; background:rgba(31,214,220,.05); font-size:12.5px; font-weight:600; text-decoration:none; transition:background .15s, border-color .15s; }
        .clk-action:hover { background:rgba(31,214,220,.1); border-color:rgba(31,214,220,.38); }
        .clk-action:focus-visible { outline:2px solid rgba(31,214,220,.55); outline-offset:2px; }
        .clk-action svg { opacity:.7; }
        .clk-action--quiet { border-color:var(--clk-line-2); background:transparent; color:var(--clk-text); }
        .clk-action--quiet:hover { background:rgba(255,255,255,.04); border-color:rgba(170,176,182,.32); }
        .clk-action--disabled { opacity:.45; cursor:not-allowed; pointer-events:none; }
        .clk-action--btn { cursor:pointer; font-family:inherit; }

        /* Reply typography (components/ClarkReply) */
        .clk-r { display:flex; flex-direction:column; gap:10px; color:#e3e6e9; font-size:14.5px; line-height:1.65; overflow-wrap:anywhere; }
        .clk-r-p { margin:0; white-space:pre-line; }
        .clk-r-field { margin:0; }
        .clk-r-key { color:#f4f6f8; font-weight:650; }
        .clk-r-verdicts { display:flex; flex-wrap:wrap; gap:8px 18px; padding:10px 12px; border:1px solid var(--clk-line); border-radius:10px; background:var(--clk-surface); }
        .clk-r-verdict { display:flex; align-items:center; gap:8px; min-width:0; }
        .clk-r-verdict-label { color:var(--clk-faint); font:650 10.5px var(--clk-mono); letter-spacing:.1em; text-transform:uppercase; }
        .clk-r-chip { padding:2px 8px; border-radius:6px; font-size:12.5px; font-weight:650; line-height:1.5; }
        .clk-r-chip--risk { color:#fecaca; background:rgba(248,113,113,.12); box-shadow:inset 0 0 0 1px rgba(248,113,113,.28); }
        .clk-r-chip--caution { color:#fde68a; background:rgba(251,191,36,.1); box-shadow:inset 0 0 0 1px rgba(251,191,36,.26); }
        .clk-r-chip--ok { color:#99f6e4; background:rgba(94,234,212,.09); box-shadow:inset 0 0 0 1px rgba(94,234,212,.26); }
        .clk-r-chip--neutral { color:#e3e6e9; background:rgba(170,176,182,.1); box-shadow:inset 0 0 0 1px var(--clk-line-2); }
        .clk-r-h { display:flex; align-items:center; gap:8px; margin:6px 0 -4px; color:#f1f3f5; font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
        .clk-r-h::before { content:''; width:6px; height:6px; border-radius:2px; background:var(--clk-faint); }
        .clk-r-h--risk::before { background:var(--clk-risk); }
        .clk-r-h--caution::before { background:var(--clk-caution); }
        .clk-r-h--ok::before { background:var(--clk-ok); }
        .clk-r-list { margin:0; padding-left:20px; display:flex; flex-direction:column; gap:3px; }
        .clk-r-list li::marker { color:var(--clk-faint); }
        .clk-r-disclaimer { margin:4px 0 0; padding-top:10px; border-top:1px solid var(--clk-line); color:var(--clk-faint); font-size:12.5px; line-height:1.55; }
        .clk-r-code { padding:1px 5px; border-radius:4px; background:var(--clk-raise-2); font:500 12.5px var(--clk-mono); }
        .clk-r-addr { font:500 12.5px var(--clk-mono); color:#cfd4d8; word-break:break-all; }
        .clk-r-link { color:var(--clk-mint-soft); text-decoration:underline; text-decoration-color:rgba(126,233,236,.35); text-underline-offset:2px; word-break:break-all; }
        .clk-r-link:hover { text-decoration-color:currentColor; }

        /* Dock: suggestions + composer */
        .clk-dock { flex:none; width:100%; max-width:836px; margin:0 auto; padding:8px 28px 14px; }
        .clk-suggest { display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; margin-bottom:8px; }
        .clk-suggest::-webkit-scrollbar { display:none; }
        .clk-suggest-btn { flex:none; height:28px; border:1px solid var(--clk-line); border-radius:999px; background:transparent; color:var(--clk-muted); font-size:12px; font-weight:600; padding:0 11px; cursor:pointer; white-space:nowrap; transition:color .15s, border-color .15s, background .15s; }
        .clk-suggest-btn:hover:not(:disabled) { color:var(--clk-text); border-color:var(--clk-line-2); background:rgba(255,255,255,.03); }
        .clk-suggest-btn:disabled { opacity:.4; cursor:not-allowed; }
        .clk-composer { position:relative; border:1px solid var(--clk-line-2); border-radius:16px; background:rgba(16,18,21,.86); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); box-shadow:0 12px 32px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.035); transition:border-color .18s, box-shadow .18s; }
        .clk-composer:focus-within { border-color:rgba(31,214,220,.42); box-shadow:0 12px 32px rgba(0,0,0,.35), 0 0 0 3px rgba(31,214,220,.07), inset 0 1px 0 rgba(255,255,255,.035); }
        .clk-input { display:block; width:100%; min-height:52px; max-height:220px; resize:none; border:0; outline:0; background:transparent; color:var(--clk-text); font:inherit; font-size:15px; line-height:1.55; padding:15px 16px 6px; caret-color:var(--clk-mint); }
        .clk-input::placeholder { color:#6f7479; }
        .clk-composer-bar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 8px 8px 10px; }
        .clk-composer-tools { display:flex; align-items:center; gap:6px; min-width:0; }
        .clk-seg { display:inline-flex; padding:2px; border-radius:9px; background:rgba(170,176,182,.08); }
        .clk-seg-btn { height:26px; border:0; border-radius:7px; background:transparent; color:var(--clk-faint); font-size:12px; font-weight:650; padding:0 10px; cursor:pointer; transition:background .15s, color .15s; }
        .clk-seg-btn:hover { color:#d4d8dc; }
        .clk-seg-btn--on { background:var(--clk-raise-2); color:#f1f3f5; box-shadow:inset 0 0 0 1px var(--clk-line-2); }
        .clk-seg-btn:focus-visible, .clk-tool-btn:focus-visible, .clk-send-btn:focus-visible, .clk-head-btn:focus-visible, .clk-suggest-btn:focus-visible, .clk-cmd-item:focus-visible { outline:2px solid rgba(31,214,220,.55); outline-offset:2px; }
        .clk-tool-btn { display:inline-flex; align-items:center; gap:6px; height:30px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--clk-muted); font-size:12px; font-weight:600; padding:0 9px; cursor:pointer; transition:background .15s, color .15s, border-color .15s; }
        .clk-tool-btn:hover:not(:disabled), .clk-tool-btn--on { color:var(--clk-text); background:rgba(255,255,255,.04); border-color:var(--clk-line); }
        .clk-tool-btn:disabled { opacity:.4; cursor:not-allowed; }
        .clk-tool-slash { color:var(--clk-mint); font:700 13px var(--clk-mono); }
        .clk-composer-send { display:flex; align-items:center; gap:10px; flex-shrink:0; }
        .clk-composer-hint { color:#666b70; font-size:11.5px; white-space:nowrap; }
        .clk-send-btn { width:34px; height:34px; border-radius:10px; border:0; color:#061012; background:var(--clk-mint); display:grid; place-items:center; cursor:pointer; transition:background .15s, opacity .15s, transform .15s; }
        .clk-page .clk-send-btn svg { flex:none; }
        .clk-send-btn:not(:disabled):hover { background:#5ee7ea; }
        .clk-send-btn:not(:disabled):active { transform:scale(.96); }
        .clk-send-btn:disabled { background:rgba(170,176,182,.16); color:#7a7f84; cursor:not-allowed; }
        .clk-send-btn--stop { background:#e8ebee; color:#0b0d0f; }
        .clk-send-btn--stop:hover { background:#ffffff !important; }
        .clk-cmd-menu { position:absolute; left:8px; right:8px; bottom:calc(100% + 8px); z-index:5; display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:2px; padding:6px; border:1px solid var(--clk-line-2); border-radius:12px; background:#111316; box-shadow:0 16px 40px rgba(0,0,0,.5); animation:clkIn .15s var(--clk-ease); }
        .clk-cmd-item { display:flex; align-items:baseline; gap:10px; min-width:0; border:0; border-radius:8px; background:transparent; padding:8px 10px; text-align:left; cursor:pointer; }
        .clk-cmd-item:hover { background:rgba(255,255,255,.045); }
        .clk-cmd-name { color:var(--clk-mint-soft); font:650 12.5px var(--clk-mono); white-space:nowrap; }
        .clk-cmd-hint { color:var(--clk-faint); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-footnote { margin:8px 0 0; text-align:center; color:#5f6469; font-size:11px; }
        .clk-upgrade-note { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:8px; padding:9px 12px; border:1px solid rgba(251,191,36,.22); border-radius:10px; background:rgba(251,191,36,.05); color:#f2e2b3; font-size:12.5px; }
        .clk-upgrade-link { color:#fde68a; text-decoration:none; font-weight:700; }

        /* Right rail: history first, context below */
        .clk-side { min-height:0; height:100%; overflow-y:auto; display:flex; flex-direction:column; border-left:1px solid var(--clk-line); background:#08090b; }
        .clk-rail-drawer-head { display:none; }
        .clk-rail-block { min-width:0; padding:14px 14px; }
        .clk-rail-block--history { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
        .clk-rail-block--context { flex:none; border-top:1px solid var(--clk-line); padding-top:6px; padding-bottom:12px; }
        .clk-rail-title { color:var(--clk-faint); font:700 10.5px var(--clk-mono); letter-spacing:.12em; text-transform:uppercase; }
        .clk-ctx-toggle { display:flex; align-items:center; gap:8px; width:100%; height:32px; border:0; border-radius:7px; background:transparent; padding:0 4px; cursor:pointer; text-align:left; }
        .clk-ctx-toggle:hover .clk-rail-title { color:var(--clk-muted); }
        .clk-ctx-toggle:focus-visible { outline:2px solid rgba(31,214,220,.55); outline-offset:1px; }
        .clk-ctx-summary { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--clk-faint); font-size:11.5px; }
        .clk-ctx-chevron { margin-left:auto; flex:none; color:var(--clk-faint); transition:transform .18s var(--clk-ease); }
        .clk-ctx-toggle[aria-expanded='false'] .clk-ctx-chevron { transform:rotate(-90deg); }
        .clk-ctx { margin:6px 0 0; padding:0 4px; display:flex; flex-direction:column; gap:6px; }
        .clk-ctx-row { display:grid; grid-template-columns:52px minmax(0, 1fr); gap:10px; align-items:baseline; }
        .clk-ctx dt { color:var(--clk-faint); font-size:11.5px; }
        .clk-ctx dd { margin:0; color:#dfe3e6; font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-ctx-movers { list-style:none; margin:10px 0 0; padding:8px 4px 0; border-top:1px solid var(--clk-line); display:flex; flex-wrap:wrap; gap:4px 12px; font:600 11.5px var(--clk-mono); }
        .clk-ctx-movers li { display:flex; gap:6px; }
        .clk-ctx-mover-sym { color:#dfe3e6; }
        .clk-up { color:#34d399; } .clk-down { color:#f87171; }
        .clk-ctx-memory { margin:10px 0 0; padding:0 4px; color:var(--clk-faint); font-size:11.5px; }
        .clk-ctx-memory--on { color:#7fdcc5; }
        .clk-rail-scrim { display:none; }

        /* Narrower desktop: the rail becomes a drawer; the workspace keeps the full width. */
        @media (max-width: 1180px) {
          .clk-shell { grid-template-columns:minmax(0, 1fr); }
          .clk-rail-toggle { display:inline-flex; }
          .clk-side { position:fixed; top:0; right:0; bottom:0; z-index:60; width:min(320px, 88vw); height:auto; background:#08090b; border-left:1px solid var(--clk-line-2); box-shadow:-24px 0 48px rgba(0,0,0,.5); transform:translateX(100%); transition:transform .2s var(--clk-ease), visibility .2s; visibility:hidden; }
          .clk-side--open { transform:translateX(0); visibility:visible; }
          .clk-rail-drawer-head { display:flex; flex:none; align-items:center; justify-content:space-between; padding:12px 10px 0 18px; color:var(--clk-muted); font:700 11px var(--clk-mono); letter-spacing:.1em; text-transform:uppercase; }
          .clk-rail-drawer-head button { border:0; border-radius:8px; background:transparent; color:var(--clk-muted); font-size:14px; cursor:pointer; min-width:40px; min-height:40px; }
          .clk-rail-drawer-head button:hover { background:rgba(255,255,255,.05); color:var(--clk-text); }
          .clk-rail-scrim { display:block; position:fixed; inset:0; z-index:59; border:0; background:rgba(1,3,4,.6); cursor:pointer; }
        }
        /* The terminal's fixed menu button sits top-left below 1024px; the header starts after it. */
        @media (max-width: 1023px) { .clk-head { padding-left:68px; min-height:60px; } }
        @media (max-width: 780px) {
          .clk-head { padding-right:12px; gap:8px; }
          .clk-usage-track { display:none; }
          .clk-scroll { padding:20px 14px 12px; }
          .clk-dock { padding:6px 10px 10px; padding-bottom:max(10px, env(safe-area-inset-bottom)); }
          .clk-welcome-grid { grid-template-columns:1fr; margin-top:22px; }
          .clk-welcome-btn { min-height:0; }
          .clk-bubble { max-width:88%; }
          .clk-msg--clark { gap:10px; }
          .clk-composer-hint, .clk-tool-label { display:none; }
          .clk-cmd-menu { grid-template-columns:1fr; }
          .clk-footnote { display:none; }
        }
        @media (max-width: 420px) {
          .clk-status { display:none; }
          .clk-usage-count { font-size:10.5px; }
          .clk-head-btn { padding:0 8px; }
        }
        @media (hover: none) {
          .clk-head-btn, .clk-tool-btn, .clk-suggest-btn { min-height:36px; }
          .clk-send-btn { width:40px; height:40px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .clk-side, .clk-welcome, .clk-msg, .clk-cmd-menu, .clk-ctx-chevron, .clk-status--busy i { transition:none; animation:none; }
        }
      `
