// Loads and checks board-relay.json. Everything the relay and agent-board need to know about a
// particular board lives in this file; nothing about it is built into the code.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const PROFILE_RE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
export const WAKE_TYPES = ['claude-session', 'command', 'resume', 'webhook'];

// Seconds. The defaults are the values the relay ran with for weeks on a busy board.
export const TIMING = {
  quietSeconds: 6,        // pings for one agent within this many seconds go out as one
  maxHoldSeconds: 30,     // and none is held longer than this before its first send
  retrySeconds: 120,      // how often an agent that was away is looked for again
  backoffMaxSeconds: 3600, // a tool wake that keeps failing for a reason that may pass is retried at 2, 4, 8 ... up to this
  goneGraceSeconds: 600,  // an agent removed from the config this long loses what waits for it
  wakeTimeoutSeconds: 1200, // a resumed tool turn is stopped after this long
};

export class ConfigError extends Error {}

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export const USER_CONFIG = join(homedir(), '.config', 'board-relay', 'board-relay.json');

/** The config file to use: --config, then BOARD_RELAY_CONFIG, then ./board-relay.json, then
 *  ~/.config/board-relay/board-relay.json (so agents in other folders find it). */
export function configPath(argvPath, env = process.env, cwd = process.cwd()) {
  const given = argvPath || env.BOARD_RELAY_CONFIG;
  if (given) return isAbsolute(given) ? given : resolve(cwd, expandHome(given));
  const local = resolve(cwd, 'board-relay.json');
  try {
    statSync(local);
    return local;
  } catch {
    return USER_CONFIG;
  }
}

export function configStamp(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new ConfigError(`no config at ${path}. Copy board-relay.example.json to board-relay.json and edit it.`);
    throw new ConfigError(`${path} is not valid JSON: ${error.message}`);
  }
  return normalize(raw, dirname(path));
}

/** A checked, filled-in copy of a parsed config. Throws ConfigError naming the first problem. Pure. */
export function normalize(raw, base = process.cwd()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('the config must be a JSON object');
  const fail = (msg) => { throw new ConfigError(msg); };

  const board = raw.board ?? 'http://127.0.0.1:4100/api/board';
  let url;
  try { url = new URL(board); } catch { fail(`board is not a URL: ${board}`); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !raw.allowRemoteBoard)
    fail('board must be a local vb serve address (127.0.0.1). Set allowRemoteBoard: true to point elsewhere on purpose.');

  const relay = raw.relay ?? 'relay';
  if (!PROFILE_RE.test(relay)) fail(`relay must be a profile name (letters, digits, hyphens): ${relay}`);

  const agents = {};
  const rawAgents = raw.agents ?? {};
  if (typeof rawAgents !== 'object' || Array.isArray(rawAgents)) fail('agents must be an object of name -> settings');
  for (const [name, entry] of Object.entries(rawAgents)) {
    if (name.startsWith('_')) continue;
    if (!PROFILE_RE.test(name)) fail(`agent name ${JSON.stringify(name)} is not a profile name (letters, digits, hyphens, up to 32)`);
    const key = name.toLowerCase();
    if (agents[key]) fail(`agent ${name} is listed twice`);
    if (key === relay.toLowerCase()) fail(`agent ${name} has the relay's own profile name`);
    if (!entry || typeof entry !== 'object') fail(`agent ${name} must be an object`);
    agents[key] = { name: key, tool: Boolean(entry.tool), wake: wakeOf(key, entry.wake, base, fail), theme: entry.theme ?? null };
  }

  const fallback = (raw.fallback ?? '').toLowerCase() || null;
  if (fallback && !agents[fallback]) fail(`fallback ${raw.fallback} is not one of the agents`);
  if (fallback && agents[fallback].tool) fail('fallback must be a session agent, not a tool: it is told when a ping cannot be delivered');

  const channels = raw.channels ?? {};
  const asks = channels.asks ?? 'decisions';
  const handoffs = channels.handoffs ?? ['handoffs'];
  if (typeof asks !== 'string' || !asks) fail('channels.asks must be a channel name');
  if (!Array.isArray(handoffs) || !handoffs.every((c) => typeof c === 'string' && c)) fail('channels.handoffs must be a list of channel names');

  const pin = raw.pin ?? [];
  if (!Array.isArray(pin)) fail('pin must be a list');
  const pins = pin.map((p, i) => {
    if (!p || typeof p.process !== 'string' || typeof p.profile !== 'string') fail(`pin[${i}] needs process (a pattern) and profile`);
    let re;
    try { re = new RegExp(p.process); } catch { fail(`pin[${i}].process is not a valid pattern`); }
    if (!PROFILE_RE.test(p.profile)) fail(`pin[${i}].profile is not a profile name`);
    return { process: re, profile: p.profile.toLowerCase() };
  });

  const timing = { ...TIMING };
  for (const [k, v] of Object.entries(raw.timing ?? {})) {
    if (!(k in TIMING)) fail(`timing.${k} is not a setting (known: ${Object.keys(TIMING).join(', ')})`);
    if (typeof v !== 'number' || !(v > 0)) fail(`timing.${k} must be a positive number of seconds`);
    timing[k] = v;
  }

  const owner = typeof raw.owner === 'string' && raw.owner.trim() ? raw.owner.trim() : 'the owner';
  const people = new Set(['me', 'user', 'human', 'owner', 'person', ...(raw.ownerNames ?? []).map((n) => String(n).toLowerCase())]);
  if (raw.owner) people.add(raw.owner.trim().toLowerCase());

  return {
    board: url.href.replace(/\/$/, ''),
    relay: relay.toLowerCase(),
    owner,
    people,
    fallback,
    agents,
    asks,
    handoffs,
    pins,
    timing,
    stateDir: resolve(base, expandHome(raw.stateDir ?? '.board-relay')),
    agentCommand: typeof raw.agentCommand === 'string' && raw.agentCommand ? raw.agentCommand : 'agent-board',
    allowLocalWebhook: Boolean(raw.allowLocalWebhook),
    allowRemoteBoard: Boolean(raw.allowRemoteBoard),
    base,
  };
}

function wakeOf(name, wake, base, fail) {
  if (wake == null) return null;
  if (typeof wake !== 'object' || !WAKE_TYPES.includes(wake.type))
    fail(`agent ${name}: wake.type must be one of ${WAKE_TYPES.join(', ')}`);
  const out = { ...wake, enabled: wake.enabled !== false };
  if (wake.cwd) out.cwd = resolve(base, expandHome(wake.cwd));
  const argvOk = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string');
  switch (wake.type) {
    case 'claude-session':
      if (!wake.name && !wake.cwd) fail(`agent ${name}: a claude-session wake needs name (the session's /rename name) or cwd`);
      out.configDirs = (wake.configDirs ?? []).map((d) => resolve(base, expandHome(d)));
      break;
    case 'command':
      if (!argvOk(wake.argv)) fail(`agent ${name}: a command wake needs argv, a list of strings`);
      break;
    case 'resume':
      if (!argvOk(wake.argv) || !wake.argv.some((a) => a.includes('{session}')))
        fail(`agent ${name}: a resume wake needs argv with a {session} placeholder`);
      if (typeof wake.sessionPattern !== 'string') fail(`agent ${name}: a resume wake needs sessionPattern, the shape of a session id`);
      if (!wake.sessionPattern.startsWith('^') || !wake.sessionPattern.endsWith('$'))
        fail(`agent ${name}: sessionPattern must be anchored with ^ and $ so a session id can never be a flag`);
      // Wrapped again so an alternation (`^a$|b`) can't escape the anchors; an id starting with "-" is refused too.
      try { out.sessionPattern = new RegExp(`^(?:${wake.sessionPattern})$`); } catch { fail(`agent ${name}: sessionPattern is not a valid pattern`); }
      if (['-x', '--x', '-', '--'].some((f) => out.sessionPattern.test(f))) fail(`agent ${name}: sessionPattern must not match a flag`);
      { const re = out.sessionPattern; out.sessionPattern = { test: (v) => typeof v === 'string' && !v.startsWith('-') && re.test(v), source: re.source }; }
      if (!wake.cwd) fail(`agent ${name}: a resume wake needs cwd, the folder the tool runs in`);
      if (wake.sessionEnv != null && wake.sessionOpenFile != null)
        fail(`agent ${name}: a resume wake takes sessionEnv or sessionOpenFile, not both`);
      if (wake.sessionEnv != null && (typeof wake.sessionEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(wake.sessionEnv)))
        fail(`agent ${name}: sessionEnv must be an environment variable name`);
      if (wake.sessionOpenFile != null) {
        let re;
        try { re = new RegExp(wake.sessionOpenFile); } catch { fail(`agent ${name}: sessionOpenFile is not a valid pattern`); }
        if (new RegExp(`${wake.sessionOpenFile}|`).exec('').length !== 2)
          fail(`agent ${name}: sessionOpenFile needs exactly one capture group, around the session id`);
        out.sessionOpenFile = re;
      }
      if (wake.passEnv != null && !(Array.isArray(wake.passEnv) && wake.passEnv.every((k) => typeof k === 'string')))
        fail(`agent ${name}: passEnv must be a list of variable names`);
      break;
    case 'webhook': {
      let u;
      try { u = new URL(wake.url); } catch { fail(`agent ${name}: webhook url is not a URL`); }
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1'))
        fail(`agent ${name}: webhook url must be https`);
      if (wake.headersFile) out.headersFile = resolve(base, expandHome(wake.headersFile));
      break;
    }
  }
  return out;
}

/** The person's words: a write with no agent profile. */
export function isPerson(by) {
  return Boolean(by && typeof by === 'object' && !by.profile && (by.actor || by.principal));
}

/** `scribe` from `local:user:ada+scribe` (or from {actor}); null for the person. */
export function profileOf(actor) {
  const a = actor && typeof actor === 'object' ? actor.actor : actor;
  if (typeof a !== 'string' || !a.includes('+')) return null;
  const name = a.slice(a.lastIndexOf('+') + 1);
  return PROFILE_RE.test(name) ? name.toLowerCase() : null; // board text: never trusted as a name unless it is one
}

/**
 * Pins from the chosen config plus every config agent-board would load by default (./board-relay.json and the
 * user config). --config and BOARD_RELAY_CONFIG pick where the board and agents come from, so a pinned program
 * could otherwise pass a config without its pin and write as anyone. A default config that fails to load adds none.
 */
export function allPins(cfg, chosen, { cwd = process.cwd(), load = loadConfig } = {}) {
  const pins = [...cfg.pins];
  const seen = new Set([resolve(chosen)]);
  for (const p of [configPath(null, {}, cwd), USER_CONFIG]) {
    const path = resolve(p);
    if (seen.has(path)) continue;
    seen.add(path);
    try { pins.push(...load(path).pins); } catch { /* none there */ }
  }
  return pins;
}
