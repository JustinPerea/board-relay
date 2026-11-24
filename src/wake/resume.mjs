// Wake a command-line tool (Codex, say) by resuming, headless, the session that last posted in the thread.
//
// When a tool posts through agent-board, the wrapper adds the label `session=<id>`, read from the tool's own
// environment (wake.sessionEnv), never from the caller. A board label can be written by anyone who reaches the
// board, so the relay treats the id as a pointer only: it must sit on a post by that tool's own profile and match
// wake.sessionPattern, which is anchored and can't match a flag. The folder the tool runs in comes from the config,
// never from the board.
//
// Rules: one wake per session at a time; the turn is stopped after wakeTimeoutSeconds; when it ends without having
// replied in the thread, the relay says so there and names its log.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { vbEnv } from '../vb.mjs';

export const SESSION_LABEL = 'session';

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : -1;
};

/** {sid} or {why, transient}. The newest post by the agent, in the given threads, that carries a session label of
 *  the right shape. read(thread) -> {messages, ok}. */
export async function recordedSession(agent, threads, cfg, read) {
  const pattern = cfg.agents[agent].wake.sessionPattern;
  let best = null;
  let failed = false;
  for (const t of threads) {
    const { messages, ok } = await read(t);
    if (!ok) { failed = true; continue; }
    for (const [id, m] of Object.entries(messages)) {
      if (String(m.by?.profile ?? '').toLowerCase() !== agent || m.deleted) continue;
      const sid = m.labels?.[SESSION_LABEL];
      if (typeof sid === 'string' && pattern.test(sid) && (!best || num(id) > best.id)) best = { id: num(id), sid };
    }
  }
  if (best) return { sid: best.sid };
  if (failed) return { why: 'the board could not be read to find the session', transient: true };
  return { why: `no \`${agent}\` session has posted in this thread, so there is none to resume. Starting a new session is yours to do` };
}

/** argv with {session} and {prompt} filled in, and the text for stdin (or null). */
export function wakeArgv(wake, sid, prompt) {
  if (!wake.sessionPattern.test(sid)) throw new Error('not a session id');
  const argv = wake.argv.map((a) => a.replaceAll('{session}', () => sid).replaceAll('{prompt}', () => prompt));
  return { argv, stdin: wake.stdin ? prompt : null };
}

/** The process's start time as ps prints it, or '' when there is none: a pid alone is reused within minutes. */
export function procStart(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

const lastId = (messages) => Math.max(0, ...Object.keys(messages).map(num));

/** Start the resumed turn in the background and return its record (the caller saves it). */
// Names that look like credentials. A woken tool signs in its own way (its login, a keychain, its config folder),
// so the relay's own keys and tokens are not passed to it unless the wake lists them in passEnv.
export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export function wakeEnv(env, passEnv = []) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_NAME.test(k) || passEnv.includes(k)) out[k] = v;
  return out;
}

export async function startWake(agent, sid, items, prompt, cfg, { read, configFile, env = process.env, running }) {
  const wake = cfg.agents[agent].wake;
  const { argv, stdin } = wakeArgv(wake, sid, prompt);
  const dir = join(cfg.stateDir, 'wakes');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const log = join(dir, `${stamp}-${agent}.log`);
  const threads = [...new Set(items.map((i) => String(i.thread)))];
  const before = {};
  for (const t of threads) before[t] = lastId((await read(t)).messages);
  const fd = openSync(log, 'w', 0o600);
  // the tool's own environment minus anything that would point vb elsewhere or lend it another identity
  const childEnv = { ...wakeEnv(vbEnv(env), wake.passEnv), BOARD_URL: cfg.board, ...(configFile ? { BOARD_RELAY_CONFIG: configFile } : {}) };
  delete childEnv.NO_COLOR;
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { cwd: wake.cwd, env: childEnv, stdio: [stdin ? 'pipe' : 'ignore', fd, fd], detached: true });
  } finally {
    closeSync(fd);
  }
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  if (stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  }
  running.set(child.pid, child);
  child.on('exit', (code) => { child.exitCode_ = code; });
  return { agent, sid, timeout: wake.timeoutSeconds ?? cfg.timing.wakeTimeoutSeconds, pid: child.pid, lstart: procStart(child.pid), started: Date.now(), log, threads, before,
    posts: items.map((i) => i.post).filter(Boolean) };
}

export function wakeAlive(rec, running) {
  const child = running.get(rec.pid);
  if (child) return child.exitCode === null && child.signalCode === null;
  // A wake started before a relay restart: alive only if the pid still has the start time recorded for it.
  return Boolean(rec.lstart) && procStart(rec.pid) === rec.lstart;
}

export async function wakeAnswered(rec, read) {
  for (const t of rec.threads) {
    const { messages } = await read(t);
    for (const [id, m] of Object.entries(messages))
      if (num(id) > (rec.before[t] ?? 0) && String(m.by?.profile ?? '').toLowerCase() === rec.agent) return true;
  }
  return false;
}

/**
 * Follow running wakes: stop the ones past the timeout, and for each that ended without replying, say so in its
 * threads. Returns true when the list changed.
 */
export async function checkWakes(state, cfg, { read, reply, running, now = Date.now(), kill = process.kill, note = () => {} }) {
  // Wakes can start while this awaits the board, so it removes the records it finished with from state.waking
  // in place, rather than replacing the list with a copy taken before the awaits.
  let changed = false;
  for (const rec of [...state.waking]) {
    let why;
    if (wakeAlive(rec, running)) {
      const limit = rec.timeout ?? cfg.timing.wakeTimeoutSeconds;
      if (now - rec.started < limit * 1000) continue;
      if (rec.stopping && now - rec.stopping > 10000) {
        try { kill(-rec.pid, 'SIGKILL'); } catch { /* gone */ }
      } else if (!rec.stopping) {
        try { kill(-rec.pid, 'SIGTERM'); } catch { /* the group is gone */ }
        rec.stopping = now;
        changed = true;
        continue;
      } else continue;
      why = `it ran past ${Math.round(limit / 60)} minutes and was stopped`;
    } else {
      const code = running.get(rec.pid)?.exitCode;
      why = rec.stopping ? `it ran past ${Math.round((rec.timeout ?? cfg.timing.wakeTimeoutSeconds) / 60)} minutes and was stopped`
        : code == null || code === 0 ? 'it finished' : `exit code ${code}`;
    }
    running.delete(rec.pid);
    state.waking = state.waking.filter((r) => r !== rec);
    changed = true;
    const answered = await wakeAnswered(rec, read);
    note(`wake ended agent=${rec.agent} pid=${rec.pid} (${why}); replied=${answered}`);
    if (!answered) {
      const where = relative(cfg.base, rec.log) || rec.log;
      for (const t of rec.threads)
        await reply(t, `Relay: I resumed \`${rec.agent}\` about this thread and it ended without replying here (${why}). Its output is in ${where}.`);
    }
  }
  return changed;
}

export function pruneWakeLogs(cfg, now = Date.now(), keepDays = 7) {
  const dir = join(cfg.stateDir, 'wakes');
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    try { if (n.endsWith('.log') && now - statSync(p).mtimeMs > keepDays * 86400000) rmSync(p); } catch { /* gone */ }
  }
}
