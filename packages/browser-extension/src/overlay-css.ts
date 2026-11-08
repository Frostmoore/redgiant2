// The page overlay's style, inside its closed shadow root (the page's CSS never reaches it).
// RedGiant's colours, light and dark after the system.
export const OVERLAY_CSS = `
:host { all: initial; }
.layer {
  --bg: #ffffff; --fg: #1d1b1a; --muted: #6b6461; --line: #e7e1de; --soft: #f6f2f0;
  --accent: #d23a2c; --accent-2: #b8301f; --accent-soft: #fbe0dc; --shadow: 0 12px 32px rgba(30, 20, 15, .18);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .layer {
    --bg: #1f1b1a; --fg: #f3eeec; --muted: #b3aaa6; --line: #3a3331; --soft: #2a2523;
    --accent: #ef4b3a; --accent-2: #ff7a68; --accent-soft: #3a1f1c; --shadow: 0 12px 32px rgba(0, 0, 0, .5);
  }
}
* { box-sizing: border-box; }
.rg-mark {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  border-radius: 28%; background: var(--accent); color: #fff;
}
.chip {
  position: fixed; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: var(--accent); color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .25);
}
.chip:hover, .chip:focus-visible { background: var(--accent-2); outline: none; }
.menu {
  position: fixed; max-height: 320px; overflow: auto; padding: 6px; border-radius: 12px;
  background: var(--bg); border: 1px solid var(--line); box-shadow: var(--shadow);
}
.menu-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px; color: var(--muted); font-size: 12.5px; }
.item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%;
  padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--fg);
  font: inherit; text-align: left; cursor: pointer; min-width: 0;
}
.item:hover, .item:focus-visible { background: var(--soft); outline: none; }
.item b, .item small { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item small { color: var(--muted); font-size: 12.5px; }
.note { margin: 4px 8px; color: var(--accent); font-size: 12.5px; }
.note:empty { display: none; }
.card {
  position: fixed; top: 16px; right: 16px; width: min(380px, calc(100vw - 32px));
  max-height: calc(100vh - 32px); overflow: auto; padding: 16px; border-radius: 16px;
  background: var(--bg); border: 1px solid var(--line); box-shadow: var(--shadow);
}
.card-head { display: flex; align-items: center; gap: 10px; }
.card-head b { flex: 1; font-size: 15.5px; }
.x {
  width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--muted);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.x:hover { background: var(--soft); color: var(--fg); }
.lead { margin: 8px 0 12px; color: var(--muted); overflow-wrap: anywhere; }
.row { display: flex; flex-direction: column; gap: 4px; margin: 0 0 10px; font-size: 12.5px; color: var(--muted); }
.row small { font-size: 12px; }
.field {
  width: 100%; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--soft); color: var(--fg); font: inherit; font-size: 14px;
}
.field:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.acts { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; font-weight: 600; cursor: pointer;
}
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover { background: var(--accent-2); }
.btn:disabled { opacity: .55; cursor: default; }
.card .note { margin: 6px 0 0; color: var(--fg); }
@media (max-width: 480px) { .card { top: 8px; right: 8px; width: calc(100vw - 16px); } }
`;
