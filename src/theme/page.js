/* board-relay theme: a color and a glyph per agent, so the board can be scanned by eye.
 *
 * apply.mjs appends this file to the inspector page's script (the page's content policy allows
 * no other script), right after a line that sets the settings it reads:
 *
 *   window.__boardRelayTheme = {
 *     agents: { <name>: { hue, glyph, style, tool } },   // hue 0-360, glyph from GLYPHS,
 *                                                        // style "holo" (one agent at most),
 *                                                        // tool true = an outside tool, muted
 *     asks: "<channel>",                                 // the channel that holds questions for the owner
 *     owner: "<display name>",
 *   };
 *
 * The theme is read-only by rule: it adds one <style>, and sets data-* attributes and CSS
 * variables on rows the page drew. It never edits the page's text, never touches the composer,
 * and never makes a request. Profile names are used as lookup keys only, never placed in a style
 * or HTML string. The only configured values that reach CSS are hues (numbers) and glyph keys
 * (looked up in the fixed GLYPHS set below).
 */
;(() => {
  'use strict';
  if (typeof document === 'undefined' || window.__boardRelayThemeOn) return;
  const cfg = window.__boardRelayTheme;
  if (!cfg || typeof cfg !== 'object') return;
  window.__boardRelayThemeOn = 1;

  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  // 24x24 shapes, used as masks so each takes its tile's ink color.
  const GLYPHS = {
    spark:    '<path d="M12 1c1 7 4 10 11 11-7 1-10 4-11 11-1-7-4-10-11-11 7-1 10-4 11-11z"/>',
    layers:   '<path d="M12 2 22 7 12 12 2 7z"/><path d="m4.6 10.7-2.6 1.3 10 5 10-5-2.6-1.3-7.4 3.7z"/><path d="m4.6 15.7-2.6 1.3 10 5 10-5-2.6-1.3-7.4 3.7z"/>',
    brackets: '<path fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M9 3H7a2 2 0 0 0-2 2v4.5L3 12l2 2.5V19a2 2 0 0 0 2 2h2M15 3h2a2 2 0 0 1 2 2v4.5l2 2.5-2 2.5V19a2 2 0 0 1-2 2h-2"/>',
    case:     '<path fill-rule="evenodd" d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm2 0h4V5h-4z"/>',
    swatch:   '<circle cx="8" cy="8" r="5.5"/><circle cx="16.5" cy="9.5" r="4.5"/><circle cx="11.5" cy="16.5" r="5"/>',
    hex:      '<path fill-rule="evenodd" d="M12 1.5 21.5 7v10L12 22.5 2.5 17V7zm0 6.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>',
    pen:      '<path fill-rule="evenodd" d="M12 1.5 19 11l-3.5 10.5h-7L5 11zm0 8.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
    trend:    '<path fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="m3 17 6-6 4 4 8-9M15 6h6v6"/>',
    bubble:   '<path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 5v-5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>',
    nodes:    '<path fill="none" stroke="#000" stroke-width="2.2" d="M6 6.5 18 8l-6.5 10z"/><circle cx="6" cy="6.5" r="3.6"/><circle cx="18" cy="8" r="3.2"/><circle cx="11.5" cy="18" r="3.8"/>',
    funnel:   '<path d="M2.5 3h19l-7.5 9v7.5l-4 2.5V12z"/>',
    egg:      '<path fill-rule="evenodd" d="M12 1.5c4.6 0 8.5 6.6 8.5 12a8.5 8.5 0 0 1-17 0c0-5.4 3.9-12 8.5-12zM8.8 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6.4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
    planet:   '<circle cx="12" cy="12" r="6.2"/><path fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" d="M5.5 14.8C3 16.5 1.7 18 2.2 18.9c.9 1.6 6.6-.2 12.7-3.9s10.2-8 9.3-9.6c-.5-.8-2.3-.7-4.8.2"/>',
    frame:    '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 6v10h16V9z"/>',
  };

  // Profiles by lowercase name. kind: agent | holo | tool (a tool is an outside program, drawn
  // muted with a dashed outline and its first letter). A holo profile gets the holographic look.
  const PROFILES = Object.create(null);
  const agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {};
  let holoTaken = false;
  for (const name of Object.keys(agents)) {
    const a = agents[name];
    if (!a || typeof a !== 'object') continue;
    const hue = Number(a.hue);
    const tool = a.tool === true;
    const holo = !tool && a.style === 'holo' && !holoTaken;
    if (holo) holoTaken = true;
    PROFILES[String(name).trim().toLowerCase()] = {
      kind: tool ? 'tool' : holo ? 'holo' : 'agent',
      hue: Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : null,
      glyph: !tool && typeof a.glyph === 'string' && has(GLYPHS, a.glyph) ? a.glyph : null,
    };
  }
  const OWNER = typeof cfg.owner === 'string' ? cfg.owner.trim().slice(0, 80) : '';
  const ASKS = typeof cfg.asks === 'string' ? cfg.asks.trim().replace(/^#/, '') : '';
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  // "#<channel>" in a thread header; a task row's channel shows as "#<channel>" or bare
  const ASKS_RE = ASKS ? new RegExp('(^|#)' + escapeRe(ASKS) + '$') : null;

  // Black for masks and for pills on a light tile; white for pills on the darker light-mode tile.
  const svg = (body, white) =>
    'url("data:image/svg+xml,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"' + (white ? ' fill="#fff">' + body.replaceAll('#000', '#fff') : '>' + body) + '</svg>') +
    '")';

  const HOLO = 'linear-gradient(100deg,#7df9ff,#b69cff,#ff8fd8,#ffe98a,#8dffc1,#7df9ff,#b69cff,#ff8fd8,#ffe98a,#8dffc1,#7df9ff)';
  const HOLO_LIGHT = 'linear-gradient(100deg,#008fb3,#6a3df0,#d6249f,#c47a00,#0a9a5a,#008fb3,#6a3df0,#d6249f,#c47a00,#0a9a5a,#008fb3)';

  const css = `
:root { --bt-tile-l: 0.80; --bt-tile-c: 0.145; --bt-name-l: 0.86; --bt-name-c: 0.13; --bt-ink: #0b0b0b; --bt-wash: 0.075; --bt-holo: ${HOLO}; }
@media (prefers-color-scheme: light) {
  :root { --bt-tile-l: 0.58; --bt-tile-c: 0.17; --bt-name-l: 0.44; --bt-name-c: 0.16; --bt-ink: #ffffff; --bt-wash: 0.09; --bt-holo: ${HOLO_LIGHT}; }
}
[data-bk] { --bt-tile: oklch(var(--bt-tile-l) var(--bt-tile-c) var(--bh, 0)); --bt-name: oklch(var(--bt-name-l) var(--bt-name-c) var(--bh, 0)); }
[data-bk="tool"] { --bt-tile-c: 0.06; --bt-name-c: 0.07; }

/* rows: a faint wash in the agent's color, laid over the page's own hover and active fills */
.message[data-bk], .task-row[data-bk] { background-image: linear-gradient(oklch(var(--bt-tile-l) var(--bt-tile-c) var(--bh, 0) / var(--bt-wash)), oklch(var(--bt-tile-l) var(--bt-tile-c) var(--bh, 0) / var(--bt-wash))); }

/* avatar tile: the agent's color, with its glyph in place of the first letter */
.message[data-bk] .gutter .avatar { background: var(--bt-tile); color: var(--bt-ink); border-color: transparent; border-radius: 7px; font-weight: 700; position: relative; overflow: hidden; }
.message[data-bg] .gutter .avatar:not(:has(img)) { color: transparent; }
.message[data-bg] .gutter .avatar:not(:has(img))::after { content: ""; position: absolute; inset: 0; background: var(--bt-ink); -webkit-mask: var(--bt-glyph) center / 64% no-repeat; mask: var(--bt-glyph) center / 64% no-repeat; }
.message[data-bk="tool"] .gutter .avatar { background: transparent; color: var(--bt-name); outline: 1.5px dashed var(--bt-name); outline-offset: -1.5px; }

/* name: the agent in its color, " via <user>" left readable but dim. The page's font is
   monospace, so the split sits at the name's length in ch; the text itself is not changed. */
.author[data-bk] { color: transparent; -webkit-background-clip: text; background-clip: text; font-weight: 700;
  --bt-split: calc(var(--bn, 99) * (1ch + var(--bls, -0.02em)) + 0.3ch);
  background-image: linear-gradient(90deg, var(--bt-name) var(--bt-split), var(--faint) var(--bt-split)); }

/* the from=<agent> label: a filled pill in the agent's color, with its glyph */
.label[data-bk] { background: var(--bt-tile); color: var(--bt-ink); border-color: transparent; font-weight: 600; border-radius: 4px; }
.label[data-bk]:hover { background: var(--bt-tile); color: var(--bt-ink); filter: brightness(1.12); }
.label[data-bg]::before { content: ""; display: inline-block; width: 0.95em; height: 0.95em; flex: none; background: currentColor; -webkit-mask: var(--bt-glyph) center / contain no-repeat; mask: var(--bt-glyph) center / contain no-repeat; }
.label[data-bk="tool"] { background: transparent; color: var(--bt-name); outline: 1px dashed var(--bt-name); outline-offset: -1px; }

/* task rows: the title is cut short before its from= label, so the agent is drawn ahead of the
   task number as a pill (glyph + name) of even width, and the titles stay in one column */
.task-row[data-bk] .task-title > .faint[data-bw]::before { content: attr(data-bw); display: inline-block; box-sizing: border-box;
  margin-right: calc(max(0, 17 - var(--bn, 17)) * (1ch - 0.02em) + 10px); padding: 0 7px 0 7px; border-radius: 4px;
  background: var(--bt-tile); color: var(--bt-ink); font-weight: 700; font-size: 11px; line-height: 17px; vertical-align: 1px; }
.task-row[data-bg] .task-title > .faint[data-bw]::before { padding-left: 23px; background: var(--bt-glyph) 6px center / 12px no-repeat, var(--bt-tile); }
.task-row[data-bk="tool"] .task-title > .faint[data-bw]::before { background: transparent; color: var(--bt-name); outline: 1px dashed var(--bt-name); outline-offset: -1px; }
.task-row[data-bk="holo"] .task-title > .faint[data-bw]::before { background: var(--bt-glyph) 6px center / 12px no-repeat, var(--bt-holo) 0 0 / 200% 100%; color: #0b0b0b; text-transform: uppercase; letter-spacing: 0.05em; animation: bt-holo-pill 10s linear infinite; }
@keyframes bt-holo-pill { 0%, 84% { background-position: 6px center, 0 0; animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1); } 100% { background-position: 6px center, -200% 0; } }
/* a narrow task list (a phone, or the list beside an open thread): the pill shrinks to its glyph */
.task-rows { container-type: inline-size; }
@container (max-width: 640px) {
  .task-row[data-bk] .task-title > .faint[data-bw]::before { font-size: 0; margin-right: 6px; padding: 0 9px; min-height: 17px; vertical-align: 4px; }
  .task-row[data-bg] .task-title > .faint[data-bw]::before { padding: 0 11px; background-position: center, 0 0; }
}

/* decision cards (the decision@1 data block agents post with board ask): plain labels in place
   of the field names, the recommendation first to the eye, and risk as a pill */
/* a question for the owner, open in the thread pane. They answer by replying, so the reply box
   says so, and the board's own task button (claim, unblock) is put away: a status change is not
   an answer. A card already claimed keeps its buttons, so it can be released. The menu beside it stays. */
.pane[data-ask] .task-card:not(:has(.task-state.claimed)) .acts .act.primary { display: none; }
.pane[data-ask] .composer::before { content: "Answer here · " var(--bt-answer, "yes / no"); display: block; margin: 0 0 6px 2px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--bright); }
.block[data-card] { max-width: 760px; font-size: 13px; border-radius: 6px; overflow: hidden; }
.block[data-card] .block-fields { gap: 5px 16px; padding: 9px 12px 10px; }
.block[data-card] .block-field dt { font-size: 0; }
.block[data-card] .block-field dt::before { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.block-field[data-f="recommend"] dt::before { content: "Recommend"; }
.block-field[data-f="if_yes"] dt::before { content: "If yes"; }
.block-field[data-f="if_no"] dt::before { content: "If no"; }
.block-field[data-f="blocking"] dt::before { content: "Blocking"; }
.block-field[data-f="risk"] dt::before { content: "Risk"; }
.block-field[data-f="answer_with"] dt::before { content: "Answer with"; }
.block-field[data-f="evidence"] dt::before { content: "More"; }
.block-field[data-f="recommend"] dd { color: var(--bright); font-weight: 600; }
.block-field[data-f="answer_with"] dd { color: var(--bright); }
.block-field[data-f="risk"] dd { justify-self: start; padding: 0 7px; border-radius: 4px; background: var(--shade-hover); color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.block-field[data-f="risk"][data-risk]:not([data-risk="none"]) dd { background: var(--red); color: var(--bg); }
/* what a yes sets in motion leads the pill; on a card with no risk word it replaces "none" */
.block-field[data-f="risk"] dd[data-does]::before { content: attr(data-does) " · "; }
.block-field[data-f="risk"][data-risk="none"] dd[data-does] { font-size: 0; background: none; color: var(--bright); box-shadow: inset 0 0 0 1px var(--muted); }
.block-field[data-f="risk"][data-risk="none"] dd[data-does]::before { content: attr(data-does); font-size: 11px; }
/* a card may carry a second risk (the also= label): it joins the first in the same pill */
.block-field[data-f="risk"] dd[data-also]::after { content: " + " attr(data-also); }
/* the card repeats these labels, so the chips under it only keep from= */
.chips .label[data-meta] { display: none; }

/* tasks page: what waits on the answer and what kind of risk it carries, in the column the page
   leaves empty; a question still written as a paragraph says so */
.task-row .task-now::before, .task-row .task-now::after { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; }
.task-row[data-wait="yes"] .task-now::before { content: "blocking"; background: var(--bright); color: var(--bg); }
/* the second pill: what a yes sets in motion (merges, pushes, deploys), then the risk words. Red only
   when the card carries a risk; a merge with no risk word still shows, outlined */
.task-row .task-now[data-does]::after { content: attr(data-does); margin-left: 5px; color: var(--bright); box-shadow: inset 0 0 0 1px var(--muted); }
.task-row .task-now[data-risk-text]::after { content: attr(data-risk-text); margin-left: 5px; background: var(--red); color: var(--bg); box-shadow: none; }
.task-row .task-now[data-does][data-risk-text]::after { content: attr(data-does) " · " attr(data-risk-text); }
/* a card the owner has answered: no longer theirs to do, so it steps back until the agent closes it */
.task-row[data-replied] { opacity: 0.5; }
/* ...and leaves the list. The switch at the bottom right shows them again (kept per browser).
   The decisions page does the same. */
body:not([data-answered="show"]) .task-row[data-replied] { display: none; }
.bt-answered { position: fixed; right: 16px; bottom: 16px; z-index: 50; font: inherit; font-size: 12px; font-weight: 600; padding: 7px 12px; border: 0; border-radius: 999px; background: var(--bg); color: var(--bright); box-shadow: inset 0 0 0 1px var(--muted); cursor: pointer; }
.bt-answered:hover { background: var(--shade-hover); }
.bt-answered[hidden] { display: none; }
.task-row[data-replied] .task-now::before { content: "replied"; color: var(--muted); box-shadow: inset 0 0 0 1px var(--faint); }
.task-row[data-card="none"] .task-now::before { content: "no card yet"; color: var(--faint); font-weight: 400; text-transform: none; letter-spacing: 0; padding: 0; }
.task-row[data-card] .task-title .label[data-meta] { display: none; }
/* at phone width the page hides this column when it holds no text; a row with a marker keeps it */
.task-row[data-wait="yes"] .task-now:empty, .task-row[data-risk]:not([data-risk="none"]) .task-now:empty, .task-row[data-card="none"] .task-now:empty, .task-row .task-now[data-does]:empty, .task-row[data-replied] .task-now:empty { display: block; }

/* a person (a post with no " via "): no color, full contrast. Their words are the ones that count. */
[data-bk="person"] { --bt-tile: var(--bright); --bt-name: var(--bright); --bt-ink: var(--bg); }
.message[data-bk="person"] { background-image: linear-gradient(var(--shade), var(--shade)); }
.author[data-bk="person"] { color: var(--bg); background: var(--bright); -webkit-background-clip: border-box; background-clip: border-box; padding: 0 7px; border-radius: 4px; }

/* holo: holographic, for one agent. The colors glint across once every 10 seconds and rest in
   between: a constant drift repainted every frame costs 5 to 7% of a core for an idle tab. */
@keyframes bt-holo-tile { 0%, 84% { background-position: 0 0; animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1); } 100% { background-position: -200% 0; } }
.message[data-bk="holo"], .task-row[data-bk="holo"] { background-image: linear-gradient(100deg, rgb(125 249 255 / 0.10), rgb(182 156 255 / 0.10) 30%, rgb(255 143 216 / 0.09) 55%, rgb(255 233 138 / 0.07) 78%, rgb(141 255 193 / 0.09)); }
.author[data-bk="holo"] { font-weight: 800; letter-spacing: 0.05em; --bls: 0.05em; text-transform: uppercase;
  background-image: linear-gradient(90deg, transparent var(--bt-split), var(--faint) var(--bt-split)), var(--bt-holo);
  background-size: 100% 100%, 200% 100%; background-repeat: no-repeat, repeat-x; animation: bt-holo-name 10s linear infinite; }
@keyframes bt-holo-name { 0%, 84% { background-position: 0 0, 0 0; animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1); } 100% { background-position: 0 0, -200% 0; } }
.message[data-bk="holo"] .gutter .avatar, .label[data-bk="holo"] { background: var(--bt-holo); background-size: 200% 100%; animation: bt-holo-tile 10s linear infinite; --bt-ink: #0b0b0b; color: #0b0b0b; }
.message[data-bk="holo"] .gutter .avatar { box-shadow: 0 0 0 1px rgb(255 255 255 / 0.35), 0 0 12px rgb(182 156 255 / 0.55); overflow: visible; }
.message[data-bk="holo"] .gutter .avatar::after { border-radius: 7px; }
@media (prefers-color-scheme: light) {
  .task-row[data-bg] .task-title > .faint[data-bw]::before { background: var(--bt-glyph-w) 6px center / 12px no-repeat, var(--bt-tile); }
  .task-row[data-bk="holo"] .task-title > .faint[data-bw]::before { background: var(--bt-glyph-w) 6px center / 12px no-repeat, var(--bt-holo) 0 0 / 200% 100%; color: #ffffff; }
  .message[data-bk="holo"] .gutter .avatar, .label[data-bk="holo"] { --bt-ink: #ffffff; color: #ffffff; }
  .message[data-bk="holo"] .gutter .avatar { box-shadow: 0 0 0 1px rgb(0 0 0 / 0.15), 0 0 10px rgb(106 61 240 / 0.35); }
}
@media (prefers-reduced-motion: reduce) {
  .author[data-bk="holo"], .message[data-bk="holo"] .gutter .avatar, .label[data-bk="holo"], .task-row[data-bk="holo"] .task-title > .faint[data-bw]::before { animation: none; }
}
${Object.keys(GLYPHS).map((k) => `[data-bg="${k}"] { --bt-glyph: ${svg(GLYPHS[k])}; --bt-glyph-w: ${svg(GLYPHS[k], true)}; }`).join('\n')}
`;

  const FIELDS = ['recommend', 'if_yes', 'if_no', 'blocking', 'risk', 'answer_with', 'evidence'];
  const RISKS = ['none', 'money', 'public', 'irreversible', 'security'];
  // a card's second risk arrives as the label also=<risk>[-<risk>]; these are the words shown for it
  const RISK_WORDS = { money: 'money', public: 'public', irreversible: "can't undo", security: 'security' };
  // does=<word>[-<word>]: what the "If yes" line says the agent will do to shared code or a live system
  const DOES = ['merges', 'pushes', 'deploys'];
  const doesWords = (v) => {
    const words = String(v || '').split('-').filter((w) => DOES.includes(w));
    return words.length ? words.join(' + ') : null;
  };
  const alsoWords = (v) => {
    const words = String(v || '').split('-').map((r) => has(RISK_WORDS, r) ? RISK_WORDS[r] : null).filter(Boolean);
    return words.length ? words.join(' + ') : null;
  };
  const PERSON = { kind: 'person', hue: 0, glyph: null };
  const hueOf = (name) => {
    let h = 7;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  };
  // A configured agent uses its own hue; one with no hue, or an agent the config does not list,
  // gets a hue derived from its name, so it keeps the same color from one load to the next.
  const lookup = (name) => {
    const key = name.trim().toLowerCase();
    if (has(PROFILES, key)) {
      const p = PROFILES[key];
      return { kind: p.kind, hue: p.hue == null ? hueOf(key) : p.hue, glyph: p.glyph };
    }
    return { kind: 'agent', hue: hueOf(key), glyph: null };
  };
  // "<agent> via <user>" is an agent's; a name with no " via " is a person's.
  const parse = (text) => {
    const t = (text || '').trim();
    if (!t) return null;
    const i = t.indexOf(' via ');
    return i > 0 ? { name: t.slice(0, i), look: lookup(t.slice(0, i)) } : { name: t, look: PERSON };
  };

  const attr = (el, name, value) => {
    if (value == null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };
  const prop = (el, name, value) => {
    if (value == null) { if (el.style.getPropertyValue(name)) el.style.removeProperty(name); }
    else if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  };
  const mark = (el, who) => {
    const look = who ? who.look : null;
    attr(el, 'data-bk', look ? look.kind : null);
    attr(el, 'data-bg', look && look.glyph && has(GLYPHS, look.glyph) ? look.glyph : null);
    prop(el, '--bh', look ? String(look.hue) : null);
  };

  const scan = () => {
    let prev = null, feed = null;
    for (const m of document.querySelectorAll('.message')) {
      if (m.parentElement !== feed) { feed = m.parentElement; prev = null; }
      const a = m.querySelector('.meta-line > .author');
      let who = null;
      if (a) {
        who = parse(a.textContent);
        mark(a, who);
        prop(a, '--bn', who ? String([...who.name].length) : null);
        prev = who;
      } else if (m.classList.contains('continued')) who = prev;
      mark(m, who);
    }
    for (const row of document.querySelectorAll('.task-row')) {
      let who = null;
      for (const l of row.querySelectorAll('.label')) {
        const t = l.textContent || '';
        if (t.startsWith('from=') && t.length > 5) { who = { name: t.slice(5), look: lookup(t.slice(5)) }; break; }
      }
      mark(row, who);
      const num = row.querySelector('.task-title > .faint');
      if (num) {
        attr(num, 'data-bw', who ? who.name : null);
        prop(num, '--bn', who ? String([...who.name].length) : null);
      }
    }
    for (const l of document.querySelectorAll('.label')) {
      const t = l.textContent || '';
      mark(l, t.startsWith('from=') && t.length > 5 ? { name: t.slice(5), look: lookup(t.slice(5)) } : null);
      attr(l, 'data-meta', /^(kind|blocking|risk|also|does|replied)=/.test(t) ? '' : null);
    }
    // decision cards: name the fields and the risk so the stylesheet can dress them
    for (const b of document.querySelectorAll('.block')) {
      const schema = (b.querySelector('.block-schema') || {}).textContent || '';
      const isCard = /^decision(@|$)/.test(schema.trim());
      attr(b, 'data-card', isCard ? '' : null);
      for (const f of b.querySelectorAll('.block-field')) {
        const key = ((f.querySelector('dt') || {}).textContent || '').trim();
        attr(f, 'data-f', isCard && FIELDS.includes(key) ? key : null);
        const risk = ((f.querySelector('dd') || {}).textContent || '').trim();
        attr(f, 'data-risk', isCard && key === 'risk' && RISKS.includes(risk) ? risk : null);
        if (isCard && key === 'risk') {
          // the second risk is a label on the post that holds the card, not a field in it
          let also = null, doing = null;
          const post = b.closest('.message');
          for (const l of (post ? post.querySelectorAll('.label') : [])) {
            const m = /^(also|does)=(.+)$/.exec(l.textContent || '');
            if (m && m[1] === 'also') also = alsoWords(m[2]);
            if (m && m[1] === 'does') doing = doesWords(m[2]);
          }
          const dd = f.querySelector('dd');
          if (dd) { attr(dd, 'data-also', also); attr(dd, 'data-does', doing); }
        }
      }
    }
    // a thread pane that holds a question for the owner: mark it, and pass the card's own
    // "answer with" words to the label over the reply box (a short, plain-character copy; the
    // default is yes / no)
    for (const pane of document.querySelectorAll('.pane')) {
      const where = ((pane.querySelector('.header .meta') || {}).textContent || '').trim();
      const ask = ASKS_RE && ASKS_RE.test(where) ? pane.querySelector('.block[data-card]') : null;
      attr(pane, 'data-ask', ask ? '' : null);
      const dd = ask ? ask.querySelector('.block-field[data-f="answer_with"] dd') : null;
      const words = ((dd || {}).textContent || '').replace(/[^\w \/.,'()+:#-]/g, '').trim().slice(0, 60);
      prop(pane, '--bt-answer', ask && words ? '"' + words + '"' : null);
    }
    // task rows: read the card's labels (the page cuts the title off before them)
    for (const row of document.querySelectorAll('.task-row')) {
      const labels = {};
      for (const l of row.querySelectorAll('.label')) {
        const m = /^(kind|blocking|risk|also|does|replied)=(.+)$/.exec(l.textContent || '');
        if (m) labels[m[1]] = m[2];
      }
      // "no card yet" only where a card is required: the channel that holds questions for the owner
      const where = ((row.querySelector('.task-where') || {}).textContent || '').trim();
      const asks = !!ASKS_RE && ASKS_RE.test(where);
      attr(row, 'data-card', labels.kind === 'decision' ? 'decision' : (asks ? 'none' : null));
      // once the owner has replied, the card waits on the agent, not on them: the relay sets replied=yes
      attr(row, 'data-replied', labels.replied === 'yes' ? '' : null);
      attr(row, 'data-wait', labels.blocking === 'yes' && labels.replied !== 'yes' ? 'yes' : null);
      attr(row, 'data-risk', RISKS.includes(labels.risk) ? labels.risk : null);
      const now = row.querySelector('.task-now');
      if (now) {
        const risky = has(RISK_WORDS, labels.risk) ? RISK_WORDS[labels.risk] : null;
        attr(now, 'data-risk-text', risky ? [risky, alsoWords(labels.also)].filter(Boolean).join(' + ') : null);
        attr(now, 'data-does', doesWords(labels.does));
      }
    }
    // the switch for answered cards: there only while the page lists some, and it says how many
    const answered = document.querySelectorAll('.task-row[data-replied]').length;
    let sw = document.querySelector('.bt-answered');
    if (!answered) {
      if (sw) sw.remove();
    } else {
      if (!sw) {
        sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'bt-answered';
        if (OWNER) sw.title = 'Cards ' + OWNER + ' has replied to';
        sw.addEventListener('click', () => {
          const show = document.body.getAttribute('data-answered') !== 'show';
          attr(document.body, 'data-answered', show ? 'show' : null);
          try { localStorage.setItem('board-relay-answered', show ? 'show' : ''); } catch { /* private window */ }
          later();
        });
        document.body.appendChild(sw);
      }
      const text = document.body.getAttribute('data-answered') === 'show'
        ? 'Hide ' + answered + ' answered'
        : answered + ' answered, waiting on an agent · show';
      if (sw.textContent !== text) sw.textContent = text;
      // keep the switch off the reply box: it sits just above the list's own composer, and it steps
      // aside while the thread pane covers the list (a phone), since the list is out of sight then
      const box = document.querySelector('main .composer');
      const pane = document.querySelector('.pane');
      let hide = false, bottom = '', right = '';
      if (box) {
        const b = box.getBoundingClientRect();
        if (b.width && b.height) {
          const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
          const p = pane ? pane.getBoundingClientRect() : null;
          hide = !!p && p.width > 0 && p.left <= cx && p.right >= cx && p.top <= cy && p.bottom >= cy;
          bottom = Math.max(16, Math.round(window.innerHeight - b.top + 8)) + 'px';
          right = Math.max(16, Math.round(window.innerWidth - b.right + 16)) + 'px';
        }
      }
      if (sw.hidden !== hide) sw.hidden = hide;
      if (sw.style.bottom !== bottom) sw.style.bottom = bottom;
      if (sw.style.right !== right) sw.style.right = right;
    }
  };

  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try { scan(); } catch { /* the theme must never break the board */ }
    });
  };

  try {
    const style = document.createElement('style');
    style.setAttribute('data-board-relay-theme', '');
    style.textContent = css;
    document.head.appendChild(style);
    try { if (localStorage.getItem('board-relay-answered') === 'show') document.body.setAttribute('data-answered', 'show'); } catch { /* private window */ }
    new MutationObserver(later).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', later, { passive: true });
    window.addEventListener('scroll', later, { passive: true, capture: true });
    later();
  } catch { /* leave the board as it was */ }
})();
