/**
 * Put the theme on the inspector page.
 *
 * The page allows one script, its own bundle (script-src 'self', a single /app.js), and
 * `vb serve` has no option for a second one. So the theme is appended to the installed bundle,
 * @vercel/board/dist/inspect/app.js, between two marker lines. The untouched bundle is kept
 * beside it as app.js.orig and every run rebuilds from that copy, so running it twice changes
 * nothing and `remove` puts the original back.
 *
 * The appended text is `window.__boardRelayTheme = <settings JSON>;` followed by page.js.
 * The board reads the bundle when it starts: restart `vb serve` afterwards and reload the tab.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLYPH_NAMES } from './glyphs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MARK = 'board-relay-theme:';
const BEGIN = `\n/* ${MARK}begin */\n`;
const END = `\n/* ${MARK}end */\n`;

/** The installed inspector bundle: dist/inspect/app.js beside the resolved @vercel/board package. */
export function defaultBundlePath() {
  const pkg = createRequire(import.meta.url).resolve('@vercel/board/package.json');
  return join(dirname(pkg), 'dist/inspect/app.js');
}

/** Turn the relay config into the settings page.js reads. Throws an Error naming the bad field. */
export function buildSettings(config) {
  if (!config || typeof config !== 'object') throw new Error('config must be an object');
  const agents = Object.create(null);
  const holo = [];
  const src = config.agents ?? {};
  if (typeof src !== 'object' || Array.isArray(src)) throw new Error('config.agents must be an object');
  for (const [name, agent] of Object.entries(src)) {
    if (name === '__proto__') throw new Error('agent name "__proto__" is not allowed');
    if (!agent || typeof agent !== 'object') throw new Error(`agents.${name} must be an object`);
    const theme = agent.theme ?? {};
    if (typeof theme !== 'object' || Array.isArray(theme)) throw new Error(`agents.${name}.theme must be an object`);
    const entry = {};
    if (theme.hue !== undefined) {
      if (typeof theme.hue !== 'number' || !Number.isFinite(theme.hue) || theme.hue < 0 || theme.hue > 360) {
        throw new Error(`agents.${name}.theme.hue must be a number from 0 to 360`);
      }
      entry.hue = theme.hue;
    }
    if (theme.glyph !== undefined) {
      if (typeof theme.glyph !== 'string' || !GLYPH_NAMES.includes(theme.glyph)) {
        throw new Error(`agents.${name}.theme.glyph must be one of: ${GLYPH_NAMES.join(', ')}`);
      }
      entry.glyph = theme.glyph;
    }
    if (theme.style !== undefined) {
      if (theme.style !== 'holo') throw new Error(`agents.${name}.theme.style must be "holo" when set`);
      entry.style = 'holo';
      holo.push(name);
    }
    if (agent.tool !== undefined && typeof agent.tool !== 'boolean') throw new Error(`agents.${name}.tool must be true or false`);
    if (agent.tool === true) entry.tool = true;
    if (entry.tool && entry.style) throw new Error(`agents.${name} is a tool and cannot take the holo style`);
    agents[name] = entry;
  }
  if (holo.length > 1) throw new Error(`only one agent can take the holo style; found ${holo.join(', ')}`);
  const asks = config.channels?.asks;
  if (asks !== undefined && (typeof asks !== 'string' || !asks.trim())) throw new Error('channels.asks must be a channel name');
  if (config.owner !== undefined && typeof config.owner !== 'string') throw new Error('owner must be a string');
  // the same default as the relay's config (src/config.mjs)
  return { agents, asks: (asks ?? 'decisions').trim(), owner: (config.owner ?? '').trim() };
}

/** JSON that is safe inside a <script>: no "<", no U+2028 or U+2029. */
export function scriptJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

function themedText(base, settings, page) {
  const json = scriptJson(settings);
  if (json.includes(MARK)) throw new Error('the config must not contain the theme marker text');
  return base + BEGIN + `window.__boardRelayTheme = ${json};\n` + page + END;
}

function strip(text) {
  const i = text.indexOf(BEGIN);
  if (i === -1) return text;
  const j = text.indexOf(END, i);
  if (j === -1) throw new Error('the bundle has a begin marker and no end marker; reinstall @vercel/board');
  return text.slice(0, i) + text.slice(j + END.length);
}

/**
 * @param {{ mode?: 'apply'|'check'|'remove', config?: object, bundlePath?: string }} options
 * @returns {Promise<{ ok: boolean, changed: boolean, message: string }>}
 */
export async function applyTheme({ mode = 'apply', config, bundlePath } = {}) {
  try {
    if (!['apply', 'check', 'remove'].includes(mode)) throw new Error(`unknown mode ${mode}`);
    const app = bundlePath ?? defaultBundlePath();
    if (!existsSync(app)) throw new Error(`no bundle at ${app}; run npm install first`);
    const orig = app + '.orig';
    const currentBuf = readFileSync(app);
    const current = currentBuf.toString('utf8');

    // The pristine copy is the installed bundle minus any theme. It is rewritten whenever the two
    // differ, so a copy left over from another package version never overwrites a new bundle.
    const pristine = strip(current);
    if (!existsSync(orig) || readFileSync(orig, 'utf8') !== pristine) {
      if (pristine === current) copyFileSync(app, orig);
      else writeFileSync(orig, pristine);
    }
    const base = readFileSync(orig, 'utf8');
    if (base.includes(BEGIN)) throw new Error('app.js.orig carries a theme; reinstall @vercel/board');

    if (mode === 'remove') {
      if (current === base) return { ok: true, changed: false, message: 'theme: the bundle is already the original' };
      copyFileSync(orig, app);
      return { ok: true, changed: true, message: 'theme: original bundle restored; restart the board' };
    }

    const page = readFileSync(join(here, 'page.js'), 'utf8');
    if (page.includes(MARK)) throw new Error('page.js must not contain the marker text');
    const next = themedText(base, buildSettings(config), page);

    if (mode === 'check') {
      const ok = current === next;
      return { ok, changed: false, message: ok ? 'theme: the bundle carries the current theme' : 'theme: the bundle is out of date; run apply' };
    }

    if (current === next) return { ok: true, changed: false, message: 'theme: already current' };

    // Write beside the bundle, syntax-check the whole file, then swap it in: a theme that does
    // not parse would blank the board, so it never reaches the real path.
    const tmp = app.replace(/app\.js$/, 'app.next.js');
    writeFileSync(tmp, next);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (error) {
      rmSync(tmp, { force: true });
      throw new Error(`the themed bundle does not parse, nothing changed:\n${String(error.stderr ?? error.message)}`);
    }
    renameSync(tmp, app);
    return { ok: true, changed: true, message: 'theme: applied; restart the board and reload the tab' };
  } catch (error) {
    return { ok: false, changed: false, message: `theme: ${error.message}` };
  }
}
