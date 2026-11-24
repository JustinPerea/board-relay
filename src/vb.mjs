// Runs the `vb` CLI from the installed @vercel/board, always against the configured board.
import { spawn } from 'node:child_process';
import { GRACE_MS, stopGroup } from './proc.mjs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** The CLI script of the installed @vercel/board. */
export function vbScript() {
  return join(dirname(require.resolve('@vercel/board')), 'cli.mjs');
}

// Variables that would point vb at a hosted board or hand it another identity.
export const ENV_DROPPED = ['BOARD_URL', 'BOARD_NAME', 'BOARD_TOKEN', 'BOARD_PROFILE', 'BOARD_AVATAR', 'VERCEL',
  'VERCEL_AUTH_TOKEN', 'VERCEL_OIDC_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'VERCEL_AUTOMATION_BYPASS_SECRET'];

export function vbEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (ENV_DROPPED.includes(k) || k.startsWith('VERCEL_')) delete out[k];
  out.NO_COLOR = '1';
  return out;
}

/** vb's argv with --url and --as placed before any `--`: after it, they would be the wrapped command's own
 *  arguments, and vb would run with no board URL and no profile. */
export function vbArgv(args, url, as) {
  const flags = [...(url ? ['--url', url] : []), ...(as ? ['--as', as] : [])];
  const dash = args.indexOf('--');
  return dash === -1 ? [vbScript(), ...args, ...flags] : [vbScript(), ...args.slice(0, dash), ...flags, ...args.slice(dash)];
}

/** Run one vb command. Resolves {code, stdout, stderr}; never rejects. */
export function runVb(args, { url, as, input, timeoutMs = 60000, env } = {}) {
  const argv = vbArgv(args, url, as);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    let done = false;
    let hard;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); clearTimeout(hard); resolve(r); } };
    try {
      child = spawn(process.execPath, argv, { env: env ?? vbEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      stopGroup(child);
      hard = setTimeout(() => finish({ code: -1, stdout, stderr: stderr + 'timed out' }), GRACE_MS + 1000);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => finish({ code: -1, stdout, stderr: stderr + String(error) }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** A board handle for the relay: every call goes to cfg.board as cfg.relay. */
export function relayBoard(cfg) {
  const run = (args, opts = {}) => runVb(args, { url: cfg.board, as: opts.as ?? cfg.relay, ...opts });

  /** {messages: {id: message}, ok}. ok is false when the board could not be read, so an empty thread and a
   *  failed read are told apart. */
  async function readThread(rootId) {
    const r = await run(['read', String(rootId), '--json']);
    const messages = {};
    if (r.code !== 0) return { messages, ok: false };
    const walk = (o) => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') {
        if ('id' in o && 'by' in o && 'channel' in o) messages[String(o.id)] = o;
        Object.values(o).forEach(walk);
      }
    };
    try { walk(JSON.parse(r.stdout)); } catch { return { messages, ok: false }; }
    return { messages, ok: true };
  }

  /** [[task id, its agent]] for every task still waiting on taskId, in any channel. */
  async function waitingOn(taskId, profileOf) {
    const found = [];
    let after = null;
    for (let i = 0; i < 20; i++) {
      const r = await run(['tasks', '--state', 'waiting', '--json', ...(after ? ['--after', after] : [])]);
      let page = {};
      try { page = r.code === 0 ? JSON.parse(r.stdout) : {}; } catch { page = {}; }
      for (const t of page.tasks ?? []) {
        const m = t.message ?? t;
        const task = m.task ?? {};
        if ((task.needs ?? []).map(String).includes(String(taskId)))
          found.push([String(m.id), profileOf(task.for) ?? profileOf(task.by)]);
      }
      const next = page.cursor ?? page.next;
      if (!page.tasks?.length || !next || next === after) break; // an empty page still carries a cursor
      after = next;
    }
    return found;
  }

  return {
    run,
    readThread,
    waitingOn,
    reply: (thread, text) => run(['reply', String(thread), text]),
    react: (post, emoji) => run(['react', String(post), emoji]),
    label: (id, kv, ...extra) => run(['label', String(id), kv, ...extra]),
  };
}
