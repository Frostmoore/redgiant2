// The design kit of agent-made pages (3.5.12): widgets and artifacts look like RedGiant without the
// agent writing design code. One stylesheet, put in the page by the runtime before the page's own
// CSS and inside a cascade layer (`rg-kit`), so any rule the page writes wins over it. It gives:
// the theme's variables (light and dark, following the host's `host-context-changed`), RedGiant's
// font, a transparent background (the frame's own colour shows through), good defaults for plain
// elements (text, forms, buttons, tables, progress, details…) and a few ready classes (`rg-*`).
// Native-looking controls are drawn (`appearance: none`): no browser checkbox, radio or select look.
// A few lines of script (in the runtime) fill what CSS cannot: the slider's value bubble and fill,
// numbers right-aligned in tables, and tabs that switch.

/** The variables of a theme, as `name:value;` pairs. */
const vars = (v: Record<string, string>) =>
  Object.entries(v)
    .map(([k, x]) => `--rg-${k}:${x};`)
    .join("");

/** RedGiant's light theme (the same values as the web's `styles.css`). */
const LIGHT = {
  bg: "#f6f7f9",
  panel: "#ffffff",
  "panel-2": "#eef0f4",
  line: "#dde1e8",
  text: "#1c2230",
  dim: "#6b7385",
  accent: "#d23a2c",
  "accent-2": "#b8301f",
  "accent-soft": "#fbe0dc",
  ok: "#2e9d5b",
  warn: "#c99a14",
  "warn-text": "#7a5600",
  err: "#d23d3d",
};

/** The dark theme. */
const DARK = {
  bg: "#15171c",
  panel: "#1c1f26",
  "panel-2": "#252932",
  line: "#313642",
  text: "#e8e6e3",
  dim: "#8f96a3",
  accent: "#ef4b3a",
  "accent-2": "#ff7a68",
  "accent-soft": "#3a1f1c",
  "warn-text": "#e0b23a",
};

/**
 * What the kit adds to each theme and the host does not send: text tones that read on a tinted
 * background (WCAG AA), the info blue, and the primary button's colour (white on it at 4.5:1 or
 * more: in the dark theme the accent is darkened, as the bright one is not).
 */
const LIGHT_KIT = {
  info: "#2f6fd1",
  "ok-text": "#1d7a45",
  "err-text": "#b42b2b",
  "info-text": "#2459b0",
  link: "var(--rg-accent)",
  btn: "var(--rg-accent)",
  "btn-hover": "color-mix(in srgb,var(--rg-accent) 86%,#000)",
  shadow: "0 1px 2px rgb(16 24 40/.06)",
};
const DARK_KIT = {
  info: "#5b9bff",
  "ok-text": "#4cc27f",
  "err-text": "#ff7b7b",
  "info-text": "#8ab8ff",
  link: "var(--rg-accent-2)",
  btn: "color-mix(in srgb,var(--rg-accent) 80%,#000)",
  "btn-hover": "color-mix(in srgb,var(--rg-accent) 70%,#000)",
  shadow: "0 1px 2px rgb(0 0 0/.35)",
};

/** Derived from the theme's variables (so they follow the host's values too). */
const DERIVED = {
  "on-accent": "#ffffff",
  field: "var(--rg-panel)",
  "line-strong": "color-mix(in srgb,var(--rg-text) 16%,var(--rg-line))",
  hover: "color-mix(in srgb,var(--rg-text) 5%,var(--rg-panel))",
  zebra: "color-mix(in srgb,var(--rg-text) 3%,var(--rg-panel))",
  track: "color-mix(in srgb,var(--rg-text) 13%,var(--rg-panel))",
  ring: "color-mix(in srgb,var(--rg-accent) 26%,transparent)",
  // Text on a tinted background (panel-2, a chip, a tab bar): darker than --rg-dim, AA there too.
  subtle: "color-mix(in srgb,var(--rg-text) 74%,var(--rg-panel))",
  font: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  mono: 'ui-monospace,"JetBrains Mono","Cascadia Code",Consolas,monospace',
  radius: "10px",
};

/** An icon (24×24, drawn with strokes) as a CSS mask: it takes the colour behind it. */
const icon = (paths: string) =>
  `url("data:image/svg+xml,${`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${paths}</svg>`
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")}")`;

const ICONS = {
  ok: icon("<circle cx='12' cy='12' r='10'/><path d='m8.5 12.5 2.5 2.5 4.5-5'/>"),
  warn: icon(
    "<path d='m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z'/><path d='M12 9v4'/><path d='M12 17h.01'/>",
  ),
  bad: icon("<circle cx='12' cy='12' r='10'/><path d='m15 9-6 6'/><path d='m9 9 6 6'/>"),
  info: icon("<circle cx='12' cy='12' r='10'/><path d='M12 16v-4'/><path d='M12 8h.01'/>"),
  check:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 12.5 4.5 4.5L19 7.5'/%3E%3C/svg%3E\")",
  imageOff: icon(
    "<path d='M2 2l20 20'/><path d='M10.4 5H19a2 2 0 0 1 2 2v8.6'/><path d='M21 21H5a2 2 0 0 1-2-2V5'/><path d='m3 16 5-5 2.5 2.5'/><path d='M14.5 14.5 16 13l5 5'/>",
  ),
  up: icon("<path d='M12 19V5'/><path d='m5 12 7-7 7 7'/>"),
  down: icon("<path d='M12 5v14'/><path d='m19 12-7 7-7-7'/>"),
};

/** Text-like inputs (every input that is a box to type or pick in). */
const FIELD =
  "input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=button],[type=submit],[type=reset],[type=image],[type=hidden]),select,textarea";
const BUTTON = "button,.rg-btn,input:is([type=button],[type=submit],[type=reset])";

/** The kit's stylesheet; `pad` is the page's own margin (a widget sits in a card already). */
function kitCss(pad: string): string {
  return `@layer rg-kit{
:root{color-scheme:light dark;${vars(LIGHT)}${vars(LIGHT_KIT)}${vars(DERIVED)}--rg-pad:${pad}}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(DARK)}${vars(DARK_KIT)}}}
:root[data-theme=dark]{color-scheme:dark;${vars(DARK)}${vars(DARK_KIT)}}
:root[data-theme=light]{color-scheme:light}
*,::before,::after{box-sizing:border-box}
html{background:transparent;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;padding:var(--rg-pad);background:transparent;color:var(--rg-text);font:14px/1.5 var(--rg-font);-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
::selection{background:color-mix(in srgb,var(--rg-accent) 24%,transparent)}
h1,h2,h3,h4,h5,h6{margin:0 0 .5em;line-height:1.25;font-weight:650;letter-spacing:-.01em;color:var(--rg-text)}
h1{font-size:1.4rem}h2{font-size:1.18rem}h3{font-size:1.03rem}h4{font-size:.93rem}
h5,h6{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--rg-dim)}
:is(p,ul,ol,dl,blockquote,figure){margin:0 0 .75em}
:is(p,ul,ol,dl,blockquote,figure,pre,table,fieldset,details,h1,h2,h3,h4,h5,h6):last-child{margin-bottom:0}
:where(:not(:first-child)):is(h1,h2,h3){margin-top:1.1em}
ul,ol{padding-left:1.3em}li+li{margin-top:.2em}
b,strong{font-weight:650}
small,.rg-muted{color:var(--rg-dim);font-size:.86em}
.rg-muted{display:block}
a{color:var(--rg-link);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:2px}
a:hover{text-decoration-color:currentColor}
hr{border:0;border-top:1px solid var(--rg-line);margin:14px 0}
code,kbd,samp{font-family:var(--rg-mono);font-size:.87em;background:var(--rg-panel-2);border-radius:5px;padding:.1em .35em}
kbd{border:1px solid var(--rg-line);border-bottom-width:2px}
pre{font-family:var(--rg-mono);font-size:12.5px;line-height:1.5;background:var(--rg-panel-2);border:1px solid var(--rg-line);border-radius:8px;padding:10px 12px;overflow:auto;margin:0 0 .75em}
pre code{background:none;padding:0;font-size:inherit}
blockquote{padding:2px 0 2px 12px;border-left:3px solid var(--rg-line);color:var(--rg-dim)}
img,video,canvas{max-width:100%}img,video{height:auto}
:is(input,output,table,meter,progress,.rg-stat,.rg-num,.rg-chip){font-variant-numeric:tabular-nums}
output{font-weight:650;color:var(--rg-text)}
button,input,select,textarea{font:inherit;color:inherit;margin:0;letter-spacing:inherit}
label{font-size:12.5px;font-weight:500;color:var(--rg-dim)}
label:has(+ :is(${FIELD})){display:block;margin-bottom:5px}
label:has(> :is(${FIELD}), > .rg-input){display:grid;grid-template-columns:minmax(0,1fr);gap:5px}
label:has(> :is(${FIELD}), > .rg-input) > :is(${FIELD}, .rg-input){font-size:14px;font-weight:400}
label:has(> input:is([type=checkbox],[type=radio])){display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:400;color:var(--rg-text);cursor:pointer}
label:has(> input[type=range]){display:grid;gap:6px}
:is(${FIELD}){appearance:none;display:block;width:100%;min-width:0;height:34px;padding:0 10px;background:var(--rg-field);color:var(--rg-text);border:1px solid var(--rg-line-strong);border-radius:8px;box-shadow:var(--rg-shadow);transition:border-color .12s,box-shadow .12s}
textarea{height:auto;min-height:84px;padding:8px 10px;line-height:1.45;resize:vertical}
select{padding-right:30px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--rg-dim) 50%),linear-gradient(135deg,var(--rg-dim) 50%,transparent 50%);background-position:calc(100% - 16px) 52%,calc(100% - 11px) 52%;background-size:5px 5px;background-repeat:no-repeat}
select:is([multiple],[size]:not([size="1"])){height:auto;padding:4px;background-image:none}
:is(${FIELD}):hover{border-color:color-mix(in srgb,var(--rg-text) 32%,var(--rg-line))}
:is(${FIELD}):focus{outline:none;border-color:var(--rg-accent);box-shadow:0 0 0 3px var(--rg-ring)}
:is(${FIELD}):user-invalid{border-color:var(--rg-err)}
:is(${FIELD}):disabled{opacity:.55;cursor:not-allowed;background-color:var(--rg-zebra)}
::placeholder{color:var(--rg-dim);opacity:.85}
input[type=number]{-moz-appearance:textfield}
input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
::-webkit-calendar-picker-indicator{opacity:.55;cursor:pointer}
::-webkit-calendar-picker-indicator:hover{opacity:.9}
input[type=search]::-webkit-search-cancel-button{opacity:.5}
input[type=color]{appearance:none;width:44px;height:34px;padding:3px;border:1px solid var(--rg-line-strong);border-radius:8px;background:var(--rg-field);cursor:pointer}
input[type=color]::-webkit-color-swatch-wrapper{padding:0}
input[type=color]::-webkit-color-swatch{border:0;border-radius:5px}
input[type=color]::-moz-color-swatch{border:0;border-radius:5px}
input[type=file]{max-width:100%;font-size:13px;color:var(--rg-dim)}
::file-selector-button{font:inherit;font-weight:550;height:30px;margin-right:10px;padding:0 12px;border:1px solid var(--rg-line-strong);border-radius:8px;background:var(--rg-panel);color:var(--rg-text);cursor:pointer}
::file-selector-button:hover{background:var(--rg-hover)}
input:is([type=checkbox],[type=radio]){appearance:none;flex:none;display:inline-block;width:18px;height:18px;margin:0;vertical-align:-4px;border:1.5px solid var(--rg-line-strong);border-radius:5px;background:var(--rg-field) no-repeat center/12px;cursor:pointer;transition:background-color .12s,border-color .12s,box-shadow .12s}
input[type=radio]{border-radius:50%}
input:is([type=checkbox],[type=radio]):hover{border-color:color-mix(in srgb,var(--rg-text) 40%,var(--rg-line))}
input[type=checkbox]:checked{background-color:var(--rg-btn);border-color:var(--rg-btn);background-image:${ICONS.check}}
input[type=checkbox]:indeterminate{background-color:var(--rg-btn);border-color:var(--rg-btn);background-image:linear-gradient(#fff,#fff);background-size:9px 2px}
input[type=radio]:checked{border-color:var(--rg-btn);background-color:var(--rg-btn);box-shadow:inset 0 0 0 3.5px var(--rg-field)}
input:is([type=checkbox],[type=radio]):focus-visible{outline:none;box-shadow:0 0 0 3px var(--rg-ring)}
input[type=radio]:checked:focus-visible{box-shadow:inset 0 0 0 3.5px var(--rg-field),0 0 0 3px var(--rg-ring)}
input:is([type=checkbox],[type=radio]):disabled{opacity:.5;cursor:not-allowed}
input[type=checkbox]:is([role=switch],.rg-switch){width:34px;height:20px;border:0;border-radius:999px;background:radial-gradient(circle,#fff 7px,transparent 7.5px) 0 50%/20px 20px no-repeat,var(--rg-track);transition:background-position .15s,background-color .15s}
input[type=checkbox]:is([role=switch],.rg-switch):checked{background:radial-gradient(circle,#fff 7px,transparent 7.5px) 100% 50%/20px 20px no-repeat,var(--rg-btn)}
input[type=range]{appearance:none;display:block;width:100%;height:22px;margin:0;padding:0;background:transparent;cursor:pointer}
input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:linear-gradient(to right,var(--rg-btn) 0 calc(9px + (100% - 18px) * var(--rg-frac,.5)),var(--rg-track) 0)}
input[type=range]::-webkit-slider-thumb{appearance:none;width:18px;height:18px;margin-top:-6px;border-radius:50%;background:#fff;border:2px solid var(--rg-btn);box-shadow:0 1px 3px rgb(0 0 0/.25);transition:box-shadow .12s}
input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:var(--rg-track)}
input[type=range]::-moz-range-progress{height:6px;border-radius:999px;background:var(--rg-btn)}
input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid var(--rg-btn);box-shadow:0 1px 3px rgb(0 0 0/.25)}
input[type=range]:focus{outline:none}
input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px var(--rg-ring)}
input[type=range]:focus-visible::-moz-range-thumb{box-shadow:0 0 0 4px var(--rg-ring)}
input[type=range]:disabled{opacity:.5;cursor:not-allowed}
progress{appearance:none;display:block;width:100%;height:8px;border:0;border-radius:999px;background:var(--rg-track);overflow:hidden;color:var(--rg-btn)}
progress::-webkit-progress-bar{background:var(--rg-track);border-radius:999px}
progress::-webkit-progress-value{background:var(--rg-btn);border-radius:999px;transition:width .2s}
progress::-moz-progress-bar{background:var(--rg-btn);border-radius:999px}
meter{display:block;width:100%;height:8px;border:0;border-radius:999px;background:var(--rg-track);overflow:hidden}
meter::-webkit-meter-inner-element{display:block}
meter::-webkit-meter-bar{height:8px;border:0;border-radius:999px;background:var(--rg-track)}
meter::-webkit-meter-optimum-value{background:var(--rg-ok);border-radius:999px}
meter::-webkit-meter-suboptimum-value{background:var(--rg-warn);border-radius:999px}
meter::-webkit-meter-even-less-good-value{background:var(--rg-err);border-radius:999px}
meter::-moz-meter-bar{border-radius:999px;background:var(--rg-ok)}
meter:-moz-meter-sub-optimum::-moz-meter-bar{background:var(--rg-warn)}
meter:-moz-meter-sub-sub-optimum::-moz-meter-bar{background:var(--rg-err)}
${BUTTON}{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border:1px solid var(--rg-line-strong);border-radius:8px;background:var(--rg-panel);color:var(--rg-text);font-size:13.5px;font-weight:550;line-height:1;white-space:nowrap;text-decoration:none;cursor:pointer;box-shadow:var(--rg-shadow);transition:background-color .12s,border-color .12s,box-shadow .12s,transform .06s}
:is(${BUTTON}):hover{background:var(--rg-hover)}
:is(${BUTTON}):active{transform:translateY(.5px)}
:is(${BUTTON}):focus-visible{outline:2px solid var(--rg-accent);outline-offset:2px}
:is(${BUTTON}):disabled{opacity:.5;cursor:not-allowed;transform:none}
:is(${BUTTON}):is(.rg-primary,[type=submit]){background:var(--rg-btn);border-color:var(--rg-btn);color:var(--rg-on-accent)}
:is(${BUTTON}):is(.rg-primary,[type=submit]):hover:not(:disabled){background:var(--rg-btn-hover);border-color:var(--rg-btn-hover)}
:is(${BUTTON}).rg-ghost{background:transparent;border-color:transparent;box-shadow:none;color:var(--rg-subtle)}
:is(${BUTTON}).rg-ghost:hover{background:var(--rg-hover);color:var(--rg-text)}
:is(${BUTTON}).rg-danger{color:var(--rg-err-text)}
:is(${BUTTON}).rg-danger:hover{background:color-mix(in srgb,var(--rg-err) 10%,var(--rg-panel));border-color:color-mix(in srgb,var(--rg-err) 45%,var(--rg-line))}
:is(${BUTTON}).rg-sm{height:28px;padding:0 10px;font-size:12.5px;border-radius:7px}
:is(${BUTTON}).rg-block{display:flex;width:100%}
:is(${BUTTON}) svg{width:16px;height:16px;flex:none}
fieldset{min-width:0;margin:0 0 .75em;padding:10px 14px 14px;border:1px solid var(--rg-line);border-radius:var(--rg-radius)}
legend{padding:0 6px;margin-left:-6px;font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--rg-dim)}
table{width:100%;margin:0 0 .75em;border-collapse:separate;border-spacing:0;border:1px solid var(--rg-line);border-radius:var(--rg-radius);overflow:hidden;background:var(--rg-panel);font-size:13px}
caption{caption-side:top;text-align:left;padding:0 0 6px;font-weight:600;color:var(--rg-text)}
th,td{padding:7px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--rg-line)}
th{font-weight:600;color:var(--rg-subtle)}
thead th{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;background:var(--rg-zebra);white-space:nowrap}
tbody tr:nth-child(even)>*{background:var(--rg-zebra)}
tbody tr:hover>*{background:var(--rg-hover)}
:is(tbody,tfoot):last-child>tr:last-child>*,table>tr:last-child>*{border-bottom:0}
tfoot>tr>*{font-weight:650;border-top:1px solid var(--rg-line-strong);background:var(--rg-panel)}
:is(td,th):is(.num,.rg-num,[data-rg-num]){text-align:right;white-space:nowrap}
.rg-scroll{max-width:100%;overflow:auto}.rg-scroll>table{margin:0}
details{margin:0 0 .75em;padding:0 14px;border:1px solid var(--rg-line);border-radius:var(--rg-radius);background:var(--rg-panel)}
summary{position:relative;list-style:none;margin:0 -14px;padding:9px 14px 9px 34px;font-weight:600;cursor:pointer;border-radius:inherit}
summary::-webkit-details-marker{display:none}
summary::before{content:"";position:absolute;left:15px;top:50%;width:6px;height:6px;border-right:1.7px solid var(--rg-dim);border-bottom:1.7px solid var(--rg-dim);transform:translate(0,-70%) rotate(-45deg);transition:transform .15s}
details[open]{padding-bottom:12px}
details[open]>summary{margin-bottom:10px;border-bottom:1px solid var(--rg-line);border-radius:var(--rg-radius) var(--rg-radius) 0 0}
details[open]>summary::before{transform:translate(0,-80%) rotate(45deg)}
summary:hover{background:var(--rg-hover)}
summary:focus-visible{outline:2px solid var(--rg-accent);outline-offset:-2px}
.rg-card{padding:14px 16px;border:1px solid var(--rg-line);border-radius:var(--rg-radius);background:var(--rg-panel)}
.rg-card>:last-child{margin-bottom:0}
.rg-card>:is(h1,h2,h3,h4):first-child{margin-top:0}
.rg-stack{display:flex;flex-direction:column;gap:12px}
.rg-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(var(--rg-min,150px),100%),1fr))}
.rg-grid>*{min-width:0}
.rg-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.rg-row>:is(${FIELD}){width:auto;flex:1 1 140px}
.rg-row>.rg-grow,.rg-spacer{flex:1 1 auto}
.rg-field{display:grid;grid-template-columns:minmax(0,1fr);gap:5px;min-width:0;margin:0;font-size:12.5px;font-weight:500;color:var(--rg-dim)}
.rg-field>:is(${FIELD},.rg-input){font-size:14px;font-weight:400}
.rg-field>:is(small,.rg-hint),.rg-hint{font-size:12px;font-weight:400;color:var(--rg-dim)}
.rg-input{display:flex;align-items:center;gap:6px;min-width:0;height:34px;padding:0 10px;border:1px solid var(--rg-line-strong);border-radius:8px;background:var(--rg-field);box-shadow:var(--rg-shadow);color:var(--rg-text);transition:border-color .12s,box-shadow .12s}
.rg-input:hover{border-color:color-mix(in srgb,var(--rg-text) 32%,var(--rg-line))}
.rg-input:focus-within{border-color:var(--rg-accent);box-shadow:0 0 0 3px var(--rg-ring)}
.rg-input>:is(input,select){flex:1 1 0;width:0;min-width:0;height:100%;padding:0;border:0;border-radius:0;background-color:transparent;box-shadow:none}
.rg-input>:is(input,select):focus{box-shadow:none}
.rg-input>:is(span,small,i,.rg-unit),.rg-unit{flex:none;color:var(--rg-dim);font-size:13px;font-style:normal;white-space:nowrap}
.rg-stat{display:flex;flex-direction:column;gap:3px;min-width:0;margin:0}
.rg-stat>:is(.rg-label,small,span:first-child:not(:only-child)){font-size:12px;font-weight:500;color:var(--rg-dim)}
.rg-stat>:is(.rg-value,strong,b){font-size:1.75rem;line-height:1.1;font-weight:700;letter-spacing:-.02em;color:var(--rg-text)}
.rg-stat>:is(.rg-value,strong,b) small{margin-left:3px;font-size:.5em;font-weight:600;letter-spacing:0;color:var(--rg-dim)}
.rg-stat.rg-sm>:is(.rg-value,strong,b){font-size:1.3rem}
.rg-stats{display:grid;gap:0;grid-template-columns:repeat(auto-fit,minmax(min(var(--rg-min,140px),100%),1fr));margin:0 0 .75em;overflow:hidden;border:1px solid var(--rg-line);border-radius:var(--rg-radius);background:var(--rg-panel)}
.rg-stats:last-child{margin-bottom:0}
.rg-stats>.rg-stat{padding:12px 14px;box-shadow:1px 0 0 var(--rg-line),0 1px 0 var(--rg-line)}
.rg-delta{display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:600;color:var(--rg-subtle)}
.rg-delta:is(.up,.down)::before{content:"";width:12px;height:12px;background:currentColor;-webkit-mask:var(--rg-arrow) center/contain no-repeat;mask:var(--rg-arrow) center/contain no-repeat}
.rg-delta.up{--rg-arrow:${ICONS.up};color:var(--rg-ok-text)}
.rg-delta.down{--rg-arrow:${ICONS.down};color:var(--rg-err-text)}
.rg-delta.ok{color:var(--rg-ok-text)}.rg-delta.bad{color:var(--rg-err-text)}.rg-delta.warn{color:var(--rg-warn-text)}
.rg-result{--rg-tone:var(--rg-info);--rg-tone-text:var(--rg-info-text);--rg-icon:${ICONS.info};position:relative;margin:0 0 .75em;padding:11px 14px 11px 42px;border:1px solid color-mix(in srgb,var(--rg-tone) 30%,var(--rg-panel));border-radius:var(--rg-radius);background:color-mix(in srgb,var(--rg-tone) 9%,var(--rg-panel));color:var(--rg-text);font-size:13.5px}
.rg-result:last-child{margin-bottom:0}
.rg-result::before{content:"";position:absolute;left:14px;top:12px;width:18px;height:18px;background:var(--rg-tone);-webkit-mask:var(--rg-icon) center/contain no-repeat;mask:var(--rg-icon) center/contain no-repeat}
.rg-result>:last-child{margin-bottom:0}
.rg-result :is(.rg-title,strong,b){color:var(--rg-tone-text)}
.rg-result>.rg-title{display:block;margin-bottom:2px;font-weight:650}
.rg-result .rg-value{display:block;font-size:1.6rem;line-height:1.15;font-weight:700;letter-spacing:-.02em;color:var(--rg-tone-text)}
:is(.rg-result,.rg-chip).ok{--rg-tone:var(--rg-ok);--rg-tone-text:var(--rg-ok-text);--rg-icon:${ICONS.ok}}
:is(.rg-result,.rg-chip).warn{--rg-tone:var(--rg-warn);--rg-tone-text:var(--rg-warn-text);--rg-icon:${ICONS.warn}}
:is(.rg-result,.rg-chip).bad{--rg-tone:var(--rg-err);--rg-tone-text:var(--rg-err-text);--rg-icon:${ICONS.bad}}
:is(.rg-result,.rg-chip).info{--rg-tone:var(--rg-info);--rg-tone-text:var(--rg-info-text);--rg-icon:${ICONS.info}}
.rg-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border:1px solid transparent;border-radius:999px;background:var(--rg-panel-2);color:var(--rg-subtle);font-size:12px;font-weight:550;line-height:1;white-space:nowrap;vertical-align:middle}
.rg-chip:is(.ok,.warn,.bad,.info){background:color-mix(in srgb,var(--rg-tone) 13%,var(--rg-panel));color:var(--rg-tone-text)}
.rg-chip:is(.ok,.warn,.bad,.info)::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--rg-tone)}
:is(${BUTTON}).rg-chip{height:28px;padding:0 12px;box-shadow:none;border-color:var(--rg-line)}
:is(${BUTTON}).rg-chip:is([aria-pressed=true],.on){background:var(--rg-accent-soft);border-color:color-mix(in srgb,var(--rg-accent) 45%,var(--rg-line));color:var(--rg-text)}
.rg-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0}
.rg-actions.end{justify-content:flex-end}
* + .rg-actions{margin-top:4px}
.rg-tabs{display:inline-flex;width:fit-content;max-width:100%;align-self:flex-start;gap:2px;padding:3px;margin:0 0 .75em;overflow-x:auto;border-radius:9px;background:var(--rg-panel-2)}
.rg-tabs>:is(button,[role=tab]){height:28px;padding:0 12px;border:0;border-radius:7px;background:transparent;box-shadow:none;color:var(--rg-subtle);font-size:13px;font-weight:550}
.rg-tabs>:is(button,[role=tab]):hover{background:transparent;color:var(--rg-text)}
.rg-tabs>:is(button,[role=tab]):is([aria-selected=true],.on,[aria-pressed=true]){background:var(--rg-panel);color:var(--rg-text);box-shadow:0 1px 2px rgb(0 0 0/.12),0 0 0 1px var(--rg-line)}
.rg-slider{position:relative;display:block;padding-top:28px}
.rg-slider>.rg-bubble{position:absolute;top:0;left:calc(9px + (100% - 18px) * var(--rg-frac,.5));transform:translateX(-50%);padding:2px 8px;border-radius:6px;background:var(--rg-text);color:var(--rg-panel);font-size:12px;font-weight:650;line-height:18px;white-space:nowrap;pointer-events:none}
.rg-slider>.rg-bubble::after{content:"";position:absolute;left:50%;bottom:-3px;width:7px;height:7px;background:inherit;transform:translateX(-50%) rotate(45deg)}
.rg-scale{display:flex;justify-content:space-between;margin-top:2px;font-size:11.5px;color:var(--rg-dim)}
/* A picture that did not load (from outside: blocked): a quiet placeholder, not a broken icon. */
img[data-rg-blocked]{display:none!important}
.rg-img-blocked{display:inline-flex;align-items:center;justify-content:center;gap:6px;max-width:100%;min-height:32px;padding:6px 10px;border:1px dashed var(--rg-line-strong);border-radius:8px;background:var(--rg-zebra);color:var(--rg-dim);font-size:12px;line-height:1.3;vertical-align:middle}
.rg-img-blocked::before{content:"";flex:none;width:14px;height:14px;background:currentColor;-webkit-mask:${ICONS.imageOff} center/contain no-repeat;mask:${ICONS.imageOff} center/contain no-repeat}
/* Inside the layout classes the gap is the spacing: children's own margins go (last, to win). */
:is(.rg-stack,.rg-grid,.rg-row,.rg-stats)>*{margin:0}
@media (max-width:480px){.rg-row:not(.rg-keep)>:is(${FIELD},.rg-field){flex-basis:100%}.rg-actions>:is(${BUTTON}){flex:1 1 auto}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
}`;
}

const squeeze = (css: string) => css.replace(/\n/g, "");

/** The kit for an artifact (its own page in the Canvas: some air around it). */
export const KIT_STYLE = squeeze(kitCss("16px"));
/** The kit for a widget (in a card of the chat, which gives the air; room for focus rings). */
export const KIT_STYLE_WIDGET = squeeze(kitCss("4px"));

/**
 * The kit's few lines of script, run by the runtime: the slider's fill and value bubble, numbers
 * right-aligned in tables, tabs that switch. On load, on every input and when the page changes.
 */
export const KIT_SCRIPT = `const K={};K.num=/^[-+\\u2212\\u00b1(]?[\\u20ac$\\u00a3\\u00a5]?\\s?\\d[\\d.,\\s'\\u2019]*\\s?(%|\\u00b0[CF]?|[a-zA-Z\\u20ac$\\u00b2\\u00b3/]{1,4})?\\)?$/;K.range=r=>{const mn=r.min===""?0:+r.min,mx=r.max===""?100:+r.max,v=+r.value;const f=mx>mn?Math.min(1,Math.max(0,(v-mn)/(mx-mn))):0;r.style.setProperty("--rg-frac",String(f));const w=r.closest(".rg-slider");if(!w)return;w.style.setProperty("--rg-frac",String(f));let o=w.querySelector(":scope>.rg-bubble");if(!o){o=document.createElement("output");o.className="rg-bubble";o.dataset.rgOwn="1";o.setAttribute("aria-hidden","true");w.appendChild(o)}if(o.dataset.rgOwn){let n=String(v);try{n=v.toLocaleString(document.documentElement.lang||undefined)}catch(_){}const t=(r.dataset.prefix||"")+n+(r.dataset.unit||"");if(o.textContent!==t)o.textContent=t}};K.table=t=>{const rows=t.tBodies.length?[].concat(...[].map.call(t.tBodies,b=>[].slice.call(b.rows))):[].slice.call(t.rows);if(rows.length>500)return;const cols=[];for(const r of rows)for(const c of r.cells){if(c.tagName!=="TD")continue;const x=c.textContent.trim();if(!x)continue;const k=cols[c.cellIndex]||(cols[c.cellIndex]={n:0,o:0});if(K.num.test(x))k.n++;else k.o++}cols.forEach((k,i)=>{if(!k||!k.n||k.o)return;for(const r of t.rows){const c=r.cells[i];if(c&&!c.hasAttribute("data-rg-num")&&c.colSpan===1)c.setAttribute("data-rg-num","")}})};K.tabs=b=>{if(b.getAttribute("role")!=="tablist")b.setAttribute("role","tablist");const items=[].filter.call(b.children,x=>x.matches("button,[role=tab]"));if(!items.length)return;if(!items.some(x=>x.getAttribute("aria-selected")==="true"||x.classList.contains("on")))items[0].setAttribute("aria-selected","true");for(const x of items){if(x.getAttribute("role")!=="tab")x.setAttribute("role","tab");const on=x.getAttribute("aria-selected")==="true"||x.classList.contains("on");if(!x.hasAttribute("aria-selected"))x.setAttribute("aria-selected",String(on));const id=x.getAttribute("aria-controls");const p=id&&document.getElementById(id);if(p&&p.hidden===on)p.hidden=!on}};K.all=()=>{K.q=0;for(const r of document.querySelectorAll("input[type=range]"))K.range(r);for(const t of document.querySelectorAll("table"))K.table(t);for(const b of document.querySelectorAll(".rg-tabs"))K.tabs(b)};K.soon=()=>{if(!K.q){K.q=1;requestAnimationFrame(K.all)}};addEventListener("input",e=>{const r=e.target;if(r instanceof HTMLInputElement&&r.type==="range")K.range(r)},true);addEventListener("change",e=>{const r=e.target;if(r instanceof HTMLInputElement&&r.type==="range")K.range(r)},true);document.addEventListener("click",e=>{const b=e.target instanceof Element?e.target.closest(".rg-tabs>button,.rg-tabs>[role=tab]"):null;if(!b||b.disabled)return;for(const x of b.parentElement.children){if(!x.matches("button,[role=tab]"))continue;const on=x===b;x.setAttribute("aria-selected",String(on));x.classList.toggle("on",on);const id=x.getAttribute("aria-controls");const p=id&&document.getElementById(id);if(p)p.hidden=!on}});const kitStart=()=>{K.all();try{new MutationObserver(K.soon).observe(document.body,{childList:true,subtree:true,characterData:true})}catch(_){}};if(document.readyState==="loading")addEventListener("DOMContentLoaded",kitStart);else kitStart();`;
