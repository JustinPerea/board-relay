// Wake an agent by running a command of yours with the ping on stdin. Exit 0 means delivered.
//
// The command gets a small environment: PATH, HOME, USER, LANG, TMPDIR, plus
//   BOARD_URL               the board's API address
//   BOARD_RELAY_CONFIG      the config file, so `agent-board` finds it from any folder
//   BOARD_RELAY_AGENT       the profile being woken
//   BOARD_RELAY_THREADS     the thread numbers, comma-separated
//   BOARD_RELAY_POSTS       the post numbers that caused it, comma-separated (may be empty)
//   BOARD_RELAY_REASON      `ping` (something on the board is for you) or `notice` (as the fallback agent: a ping
//                           to another agent could not be delivered; the threads are that agent's)
// The ping holds thread numbers and commands only; the command reads the board for anything else.
import { spawn } from 'node:child_process';
import { GRACE_MS, stopGroup } from '../proc.mjs';

const KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SHELL'];

export function commandEnv(agent, items, cfg, configFile, env = process.env, reason = 'ping') {
  const out = {};
  for (const k of KEEP) if (env[k]) out[k] = env[k];
  out.BOARD_URL = cfg.board;
  if (configFile) out.BOARD_RELAY_CONFIG = configFile;
  out.BOARD_RELAY_AGENT = agent;
  out.BOARD_RELAY_THREADS = [...new Set(items.map((i) => i.thread))].join(',');
  out.BOARD_RELAY_POSTS = items.map((i) => i.post).filter(Boolean).join(',');
  out.BOARD_RELAY_REASON = reason;
  return out;
}

export function deliver(agent, text, items, cfg, { configFile, env, reason } = {}) {
  const wake = cfg.agents[agent].wake;
  const timeoutMs = (wake.timeoutSeconds ?? 120) * 1000;
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(wake.argv[0], wake.argv.slice(1), {
        cwd: wake.cwd ?? cfg.base, env: commandEnv(agent, items, cfg, configFile, env, reason), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
    } catch (error) {
      resolve({ ok: false, why: `\`${agent}\`'s command could not start (${error.code ?? error.message})` });
      return;
    }
    let timedOut = false;
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); clearTimeout(hard); resolve(r); } };
    let hard;
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup(child);
      hard = setTimeout(() => finish({ ok: false, why: `\`${agent}\`'s command ran past ${wake.timeoutSeconds ?? 120} s and could not be stopped` }), GRACE_MS + 1000);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out = (out + d).slice(-2000); });
    child.stderr.on('data', (d) => { out = (out + d).slice(-2000); });
    child.on('error', (error) => {
      finish({ ok: false, why: `\`${agent}\`'s command could not start (${error.code ?? error.message})` });
    });
    child.on('close', (code) => {
      if (code === 0 && !timedOut) finish({ ok: true });
      else finish({ ok: false, why: timedOut ? `\`${agent}\`'s command ran past ${wake.timeoutSeconds ?? 120} s and was stopped`
        : `\`${agent}\`'s command exited with code ${code}`, detail: out.slice(-300) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}
