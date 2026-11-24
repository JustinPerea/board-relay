// The wake adapters themselves: webhook, command, resume, claude-session.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { normalize } from '../src/config.mjs';
import * as webhook from '../src/wake/webhook.mjs';
import * as command from '../src/wake/command.mjs';
import * as resume from '../src/wake/resume.mjs';
import * as claude from '../src/wake/claude-session.mjs';

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  dirs.push(d);
  return d;
};
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ITEMS = [{ thread: '5', post: '6', what: 'reply' }, { thread: '5', post: '7', what: 'reply' }, { thread: '9', post: null, what: 'new post' }];

// ================================================================ webhook

async function hookServer() {
  const seen = [];
  const ctl = { status: 200 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url === '/redir') {
        res.writeHead(302, { location: '/other' });
        res.end();
      } else {
        res.writeHead(req.url === '/hook' ? ctl.status : 200);
        res.end('ok');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { server, seen, ctl, port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

function hookCfg(dir, port, { route = '/hook', headersFile = path.join(dir, 'headers.json'), extra = {} } = {}) {
  return normalize({
    allowLocalWebhook: true,
    agents: { hook: { tool: true, wake: { type: 'webhook', url: `http://127.0.0.1:${port}${route}`, headersFile, ...extra } } },
  }, dir);
}

function writeHeaders(dir, mode = 0o600) {
  const f = path.join(dir, 'headers.json');
  fs.writeFileSync(f, JSON.stringify({ authorization: 'Bearer test' }));
  fs.chmodSync(f, mode);
  return f;
}

test('webhook: 200 delivers the header and a body of numbers and the prompt, with no post text', async () => {
  const dir = tmp();
  writeHeaders(dir);
  const h = await hookServer();
  try {
    const cfg = hookCfg(dir, h.port);
    const state = { webhookLast: {} };
    const r = await webhook.deliver('hook', ITEMS, 'PROMPT TEXT', cfg, state, { now: 1_000_000 });
    assert.deepEqual(r, { ok: true });
    assert.equal(h.seen.length, 1);
    assert.equal(h.seen[0].method, 'POST');
    assert.equal(h.seen[0].headers.authorization, 'Bearer test');
    const body = JSON.parse(h.seen[0].body);
    assert.deepEqual(body.threads, ['5', '9']);
    assert.deepEqual(body.posts, ['6', '7']);
    assert.equal(body.prompt, 'PROMPT TEXT');
    assert.equal(body.agent, 'hook');
    assert.ok(!('text' in body));
    assert.equal(state.webhookLast.hook, 1_000_000);
  } finally { await h.close(); }
});

test('webhook: a second call inside the cooldown is busy; after it, goes through', async () => {
  const dir = tmp();
  writeHeaders(dir);
  const h = await hookServer();
  try {
    const cfg = hookCfg(dir, h.port);
    const state = { webhookLast: {} };
    assert.equal((await webhook.deliver('hook', ITEMS, 'p', cfg, state, { now: 1_000_000 })).ok, true);
    const r = await webhook.deliver('hook', ITEMS, 'p', cfg, state, { now: 1_010_000 });
    assert.equal(r.ok, false);
    assert.equal(r.busy, true);
    assert.equal(r.transient, true);
    assert.equal(h.seen.length, 1);
    assert.equal((await webhook.deliver('hook', ITEMS, 'p', cfg, state, { now: 1_121_000 })).ok, true);
    assert.equal(h.seen.length, 2);
  } finally { await h.close(); }
});

test('webhook: a 500 is transient and busy, and does not start the cooldown', async () => {
  const dir = tmp();
  writeHeaders(dir);
  const h = await hookServer();
  try {
    h.ctl.status = 500;
    const state = { webhookLast: {} };
    const r = await webhook.deliver('hook', ITEMS, 'p', hookCfg(dir, h.port), state, { now: 1_000_000 });
    assert.equal(r.ok, false);
    assert.equal(r.busy, true);
    assert.equal(r.transient, true);
    assert.deepEqual(state.webhookLast, {});
  } finally { await h.close(); }
});

test('webhook: a 403 is final', async () => {
  const dir = tmp();
  writeHeaders(dir);
  const h = await hookServer();
  try {
    h.ctl.status = 403;
    const r = await webhook.deliver('hook', ITEMS, 'p', hookCfg(dir, h.port), { webhookLast: {} }, { now: 1_000_000 });
    assert.equal(r.ok, false);
    assert.ok(!r.transient && !r.busy);
    assert.match(r.why, /403/);
  } finally { await h.close(); }
});

test('webhook: a 302 is not followed and is final', async () => {
  const dir = tmp();
  writeHeaders(dir);
  const h = await hookServer();
  try {
    const r = await webhook.deliver('hook', ITEMS, 'p', hookCfg(dir, h.port, { route: '/redir' }), { webhookLast: {} }, { now: 1_000_000 });
    assert.equal(r.ok, false);
    assert.ok(!r.transient && !r.busy);
    assert.match(r.why, /redirect/);
    assert.equal(h.seen.length, 1);
    assert.equal(h.seen[0].url, '/redir');
  } finally { await h.close(); }
});

test('webhook: a headers file readable by others is refused, a missing one is reported', async () => {
  const dir = tmp();
  const h = await hookServer();
  try {
    const cfg = hookCfg(dir, h.port);
    const missing = await webhook.deliver('hook', ITEMS, 'p', cfg, { webhookLast: {} }, { now: 1_000_000 });
    assert.equal(missing.ok, false);
    assert.match(missing.why, /no headers file/);

    writeHeaders(dir, 0o644);
    const open = await webhook.deliver('hook', ITEMS, 'p', cfg, { webhookLast: {} }, { now: 1_000_000 });
    assert.equal(open.ok, false);
    assert.match(open.why, /mode 600/);
    assert.equal(h.seen.length, 0); // nothing sent in either case
  } finally { await h.close(); }
});

test('webhook: a non-https url is refused unless allowLocalWebhook and 127.0.0.1', async () => {
  const dir = tmp();
  const cfg = normalize({ agents: { hook: { tool: true, wake: { type: 'webhook', url: 'http://127.0.0.1:9/hook' } } } }, dir);
  const r = await webhook.deliver('hook', ITEMS, 'p', cfg, { webhookLast: {} }, { now: 1_000_000 });
  assert.equal(r.ok, false);
  assert.match(r.why, /not https/);
});

// ================================================================ command

function cmdCfg(dir, script, extra = {}) {
  return normalize({
    agents: { scribe: { wake: { type: 'command', argv: [process.execPath, '-e', script], ...extra } } },
  }, dir);
}

test('command: the ping goes to stdin, the threads and reason to the environment', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out.json');
  const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({stdin:s,env:process.env})))`;
  const r = await command.deliver('scribe', 'PING TEXT', ITEMS, cmdCfg(dir, script), { configFile: '/x/board-relay.json', reason: 'notice' });
  assert.deepEqual(r, { ok: true });
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(got.stdin, 'PING TEXT');
  assert.equal(got.env.BOARD_RELAY_THREADS, '5,9');
  assert.equal(got.env.BOARD_RELAY_POSTS, '6,7');
  assert.equal(got.env.BOARD_RELAY_REASON, 'notice');
  assert.equal(got.env.BOARD_RELAY_AGENT, 'scribe');
  assert.equal(got.env.BOARD_RELAY_CONFIG, '/x/board-relay.json');
  assert.equal(got.env.BOARD_URL, 'http://127.0.0.1:4100/api/board');
});

test('command: the environment holds only the documented variables', async () => {
  const dir = tmp();
  const out = path.join(dir, 'env.json');
  const script = `require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify(process.env))`;
  const env = { ...process.env, SECRET_SENTINEL: '1', ANTHROPIC_API_KEY: 'k', PATH: process.env.PATH };
  const r = await command.deliver('scribe', 'x', ITEMS, cmdCfg(dir, script), { env });
  assert.equal(r.ok, true);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(!('SECRET_SENTINEL' in got));
  assert.ok(!('ANTHROPIC_API_KEY' in got));
  const documented = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SHELL', 'BOARD_URL', 'BOARD_RELAY_CONFIG',
    'BOARD_RELAY_AGENT', 'BOARD_RELAY_THREADS', 'BOARD_RELAY_POSTS', 'BOARD_RELAY_REASON',
    '__CF_USER_TEXT_ENCODING']); // added by macOS to every process
  for (const k of Object.keys(got)) assert.ok(documented.has(k), `undocumented variable ${k}`);
});

test('command: a nonzero exit is a failure naming the code', async () => {
  const dir = tmp();
  const r = await command.deliver('scribe', 'x', ITEMS, cmdCfg(dir, 'process.exit(3)'), {});
  assert.equal(r.ok, false);
  assert.match(r.why, /exited with code 3/);
});

test('command: a command that outlives timeoutSeconds is stopped', async () => {
  const dir = tmp();
  const t0 = Date.now();
  const r = await command.deliver('scribe', 'x', ITEMS, cmdCfg(dir, 'setTimeout(()=>{},30000)', { timeoutSeconds: 1 }), {});
  assert.equal(r.ok, false);
  assert.match(r.why, /was stopped/);
  assert.ok(Date.now() - t0 < 10_000);
});

test('command: a command that cannot start is a failure', async () => {
  const dir = tmp();
  const cfg = normalize({ agents: { scribe: { wake: { type: 'command', argv: ['/nonexistent/binary-xyz'] } } } }, dir);
  const r = await command.deliver('scribe', 'x', ITEMS, cfg, {});
  assert.equal(r.ok, false);
  assert.match(r.why, /could not start/);
});

// ================================================================ resume

const SID = /^[0-9a-f]{8}$/;
function resumeCfg(dir, argv, extra = {}) {
  return normalize({
    agents: { codex: { tool: true, wake: { type: 'resume', argv, sessionPattern: '^[0-9a-f]{8}$', cwd: dir, ...extra } } },
  }, dir);
}
const msg = (profile, labels = {}, extra = {}) => ({ by: { profile, actor: `local:user:ada+${profile}` }, labels, deleted: false, ...extra });
const readOf = (messages, ok = true) => async () => ({ messages, ok });

test('resume.recordedSession: newest post by that profile with a matching session label', async () => {
  const cfg = resumeCfg(tmp(), ['codex', '{session}']);
  const messages = {
    4: msg('codex', { session: 'aaaaaaaa' }),
    5: msg('codex', { session: 'bbbbbbbb' }),
    6: msg('lead', { session: 'cccccccc' }),     // someone else's label
    7: msg('codex', { session: '--help' }),      // not a session id
    8: msg('codex', {}),                          // no label
    9: msg('codex', { session: 'dddddddd' }, { deleted: true }),
  };
  assert.deepEqual(await resume.recordedSession('codex', ['5'], cfg, readOf(messages)), { sid: 'bbbbbbbb' });
  // ids compare as numbers: 10 is newer than 9
  const more = { ...messages, 10: msg('codex', { session: 'eeeeeeee' }), 9: msg('codex', { session: 'dddddddd' }) };
  assert.deepEqual(await resume.recordedSession('codex', ['5'], cfg, readOf(more)), { sid: 'eeeeeeee' });
});

test('resume.recordedSession: only bad labels is "no session"; a failed read is transient', async () => {
  const cfg = resumeCfg(tmp(), ['codex', '{session}']);
  const none = await resume.recordedSession('codex', ['5'], cfg, readOf({ 7: msg('codex', { session: '--help' }), 8: msg('lead', { session: 'aaaaaaaa' }) }));
  assert.equal(none.sid, undefined);
  assert.ok(!none.transient);
  const failed = await resume.recordedSession('codex', ['5'], cfg, readOf({}, false));
  assert.equal(failed.sid, undefined);
  assert.equal(failed.transient, true);
});

test('resume.recordedSession: one thread unreadable but another has a session still finds it', async () => {
  const cfg = resumeCfg(tmp(), ['codex', '{session}']);
  const read = async (t) => (t === '5' ? { messages: {}, ok: false } : { messages: { 9: msg('codex', { session: 'aaaaaaaa' }) }, ok: true });
  assert.deepEqual(await resume.recordedSession('codex', ['5', '6'], cfg, read), { sid: 'aaaaaaaa' });
});

test('resume.wakeArgv fills {session} and {prompt}, and throws on a bad id', () => {
  const wake = { argv: ['codex', 'resume', '{session}', '{prompt}'], sessionPattern: SID, stdin: false };
  assert.deepEqual(resume.wakeArgv(wake, 'abcdef01', 'hello'), { argv: ['codex', 'resume', 'abcdef01', 'hello'], stdin: null });
  assert.deepEqual(resume.wakeArgv({ ...wake, stdin: true }, 'abcdef01', 'hello').stdin, 'hello');
  assert.throws(() => resume.wakeArgv(wake, '--help', 'x'), /not a session id/);
  assert.throws(() => resume.wakeArgv(wake, 'abcdef01; rm', 'x'), /not a session id/);
});

test('resume.wakeArgv puts a prompt holding "$" in the argv unchanged', () => {
  const wake = { argv: ['codex', '{prompt}'], sessionPattern: SID };
  const prompt = 'costs $$5 and $& more';
  assert.equal(resume.wakeArgv(wake, 'abcdef01', prompt).argv[1], prompt);
});

async function exited(running, pid) {
  const child = running.get(pid);
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
}

test('resume.startWake records the wake; checkWakes says so when the agent never replied', async () => {
  const dir = tmp();
  const cfg = resumeCfg(dir, [process.execPath, '-e', 'setTimeout(()=>{}, 50)', '{session}']);
  const running = new Map();
  const state = { waking: [] };
  const read = readOf({ 5: msg('lead') });
  const rec = await resume.startWake('codex', 'abcdef01', [{ thread: '5', post: '6', what: 'reply' }], 'PROMPT', cfg, { read, running });
  state.waking.push(rec);
  assert.equal(rec.agent, 'codex');
  assert.equal(rec.sid, 'abcdef01');
  assert.ok(Number.isInteger(rec.pid) && rec.pid > 0);
  assert.deepEqual(rec.threads, ['5']);
  assert.deepEqual(rec.before, { 5: 5 });
  assert.deepEqual(rec.posts, ['6']);
  assert.ok(fs.existsSync(rec.log));
  assert.equal(fs.statSync(rec.log).mode & 0o077, 0);
  assert.ok(running.has(rec.pid));

  await exited(running, rec.pid);
  const replies = [];
  const changed = await resume.checkWakes(state, cfg, { read, reply: async (t, x) => { replies.push([t, x]); }, running, now: Date.now() });
  assert.equal(changed, true);
  assert.equal(state.waking.length, 0);
  assert.equal(running.size, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], '5');
  assert.match(replies[0][1], /ended without replying/);
});

test('resume.checkWakes says nothing when the agent replied after the wake started', async () => {
  const dir = tmp();
  const cfg = resumeCfg(dir, [process.execPath, '-e', 'setTimeout(()=>{}, 50)', '{session}']);
  const running = new Map();
  const rec = await resume.startWake('codex', 'abcdef01', [{ thread: '5', post: '6', what: 'reply' }], 'P', cfg, { read: readOf({ 5: msg('lead') }), running });
  const state = { waking: [rec] };
  await exited(running, rec.pid);
  const replies = [];
  const read = readOf({ 5: msg('lead'), 7: msg('codex') });
  await resume.checkWakes(state, cfg, { read, reply: async (t, x) => { replies.push([t, x]); }, running, now: Date.now() });
  assert.deepEqual(replies, []);
  assert.equal(state.waking.length, 0);
});

test('resume.checkWakes keeps a wake that started while it was waiting on the board', async () => {
  const dir = tmp();
  const cfg = resumeCfg(dir, [process.execPath, '-e', 'setTimeout(()=>{}, 50)', '{session}']);
  const running = new Map();
  const rec = await resume.startWake('codex', 'abcdef01', [{ thread: '5', post: '6', what: 'reply' }], 'P', cfg, { read: readOf({ 5: msg('lead') }), running });
  const state = { waking: [rec] };
  await exited(running, rec.pid);
  const late = { agent: 'codex', pid: 999999, started: Date.now(), threads: ['8'], posts: [], before: {}, log: rec.log };
  // the board read during the check is where a new wake can slip in
  const read = async (id) => { if (!state.waking.includes(late)) state.waking.push(late); return readOf({ 5: msg('lead') })(id); };
  await resume.checkWakes(state, cfg, { read, reply: async () => {}, running, now: Date.now() });
  assert.deepEqual(state.waking, [late]);
});

test('resume.checkWakes keeps a wake that is still running', async () => {
  const dir = tmp();
  const cfg = resumeCfg(dir, [process.execPath, '-e', 'setTimeout(()=>{}, 30000)', '{session}']);
  const running = new Map();
  const rec = await resume.startWake('codex', 'abcdef01', [{ thread: '5', post: null, what: 'x' }], 'P', cfg, { read: readOf({ 5: msg('lead') }), running });
  try {
    const state = { waking: [rec] };
    const changed = await resume.checkWakes(state, cfg, { read: readOf({}), reply: async () => assert.fail('no reply'), running, now: Date.now() });
    assert.equal(changed, false);
    assert.equal(state.waking.length, 1);

    // past the timeout it is stopped (kill is injected, nothing real is signalled)
    const kills = [];
    const late = Date.now() + cfg.timing.wakeTimeoutSeconds * 1000 + 1;
    const replies = [];
    const opts = (now) => ({ read: readOf({}), reply: async (t, x) => { replies.push(x); }, running, now, kill: (...a) => { kills.push(a); } });
    await resume.checkWakes(state, cfg, opts(late));
    assert.deepEqual(kills, [[-rec.pid, 'SIGTERM']]);
    assert.equal(state.waking.length, 1, 'kept while it gets a chance to stop');
    assert.equal(replies.length, 0);
    await resume.checkWakes(state, cfg, opts(late + 11000));
    assert.deepEqual(kills[1], [-rec.pid, 'SIGKILL']);
    assert.equal(state.waking.length, 0);
    assert.match(replies[0], /was stopped/);
  } finally {
    try { process.kill(-rec.pid, 'SIGTERM'); } catch { /* gone */ }
    running.get(rec.pid)?.kill('SIGTERM');
  }
});

// ================================================================ claude-session

function sessCfg() {
  return normalize({
    agents: {
      lead: { wake: { type: 'claude-session', name: 'Lead', cwd: '/proj/a' } },
      twin: { wake: { type: 'claude-session', name: 'Twin', cwd: '/proj/a' } },
      solo: { wake: { type: 'claude-session', cwd: '/proj/solo' } },
    },
  }, tmp());
}
const S = (name, cwd, n) => ({ name, cwd, address: `uds:/s${n}`, pid: n });

test('findSession matches by name, case-insensitively', () => {
  const cfg = sessCfg();
  assert.deepEqual(claude.findSession('lead', cfg, [S('lEAd', '/elsewhere', 1), S('Twin', '/elsewhere', 2)]), { address: 'uds:/s1' });
});

test('findSession falls back to the folder only when no other agent shares it', () => {
  const cfg = sessCfg();
  // solo is alone in its folder
  assert.deepEqual(claude.findSession('solo', cfg, [S('', '/proj/solo', 1)]), { address: 'uds:/s1' });
  // lead and twin share /proj/a: an unnamed session there belongs to neither
  const r = claude.findSession('lead', cfg, [S('', '/proj/a', 1)]);
  assert.equal(r.address, undefined);
  assert.match(r.why, /no live session/);
});

test('findSession reports ambiguity and absence', () => {
  const cfg = sessCfg();
  const two = claude.findSession('lead', cfg, [S('Lead', '/x', 1), S('lead', '/y', 2)]);
  assert.match(two.why, /more than one live session/);
  const twoSolo = claude.findSession('solo', cfg, [S('', '/proj/solo', 1), S('', '/proj/solo', 2)]);
  assert.match(twoSolo.why, /more than one live session/);
  assert.match(claude.findSession('lead', cfg, []).why, /has no live session/);
});

test('liveSessions lists records with a live pid and an existing socket', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sessions'));
  const sock = path.join(dir, 'a.sock');
  fs.writeFileSync(sock, '');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const put = (n, rec) => fs.writeFileSync(path.join(dir, 'sessions', n), typeof rec === 'string' ? rec : JSON.stringify(rec));
  put('a.json', { pid: process.pid, name: 'Lead', cwd: '/proj/a/', messagingSocketPath: sock });
  put('dead.json', { pid: dead, name: 'Dead', messagingSocketPath: sock + '2' });
  fs.writeFileSync(sock + '2', '');
  put('nosock.json', { pid: process.pid, name: 'NoSock', messagingSocketPath: path.join(dir, 'missing.sock') });
  put('nopath.json', { pid: process.pid, name: 'NoPath' });
  put('junk.json', 'not json');
  put('notes.txt', 'ignored');
  const list = claude.liveSessions([dir, path.join(dir, 'no-such-dir')]);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { name: 'Lead', cwd: '/proj/a', address: `uds:${sock}`, pid: process.pid });
});

test('liveSessions does not list a record whose pid is 0 or null', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sessions'));
  const sock = path.join(dir, 'a.sock');
  fs.writeFileSync(sock, '');
  fs.writeFileSync(path.join(dir, 'sessions', 'z.json'), JSON.stringify({ pid: null, name: 'Z', messagingSocketPath: sock }));
  fs.writeFileSync(path.join(dir, 'sessions', 'y.json'), JSON.stringify({ pid: 0, name: 'Y', messagingSocketPath: sock + 'x' }));
  fs.writeFileSync(sock + 'x', '');
  assert.deepEqual(claude.liveSessions([dir]), []);
});

test('claude deliver retries a failed send once, then succeeds', async () => {
  const cfg = sessCfg();
  const sessions = [S('Lead', '/x', 1)];
  const sent = [];
  let n = 0;
  const send = async (address, text) => { sent.push([address, text]); return ++n === 1 ? { ok: false, detail: 'boom' } : { ok: true }; };
  assert.deepEqual(await claude.deliver('lead', 'PING', cfg, { sessions, send }), { ok: true });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], ['uds:/s1', 'PING']);
});

test('claude deliver gives up after two failed sends, and reports a missing session as away', async () => {
  const cfg = sessCfg();
  let n = 0;
  const send = async () => { n++; return { ok: false, detail: 'boom' }; };
  const r = await claude.deliver('lead', 'PING', cfg, { sessions: [S('Lead', '/x', 1)], send });
  assert.equal(r.ok, false);
  assert.equal(n, 2);
  assert.match(r.why, /did not send/);
  assert.equal(r.detail, 'boom');

  const away = await claude.deliver('lead', 'PING', cfg, { sessions: [], send });
  assert.equal(away.ok, false);
  assert.equal(away.away, true);
  assert.equal(n, 2); // nothing sent
});

test('claude reachable follows findSession', () => {
  const cfg = sessCfg();
  assert.equal(claude.reachable('lead', cfg, [S('Lead', '/x', 1)]), true);
  assert.equal(claude.reachable('lead', cfg, []), false);
});

test('command: a program that ignores SIGTERM is killed, and the delivery still ends', { timeout: 30000 }, async () => {
  const { normalize } = await import('../src/config.mjs');
  const cmd = await import('../src/wake/command.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-hang-'));
  try {
    const cfg = normalize({ agents: { stub: { wake: { type: 'command', argv: ['sh', '-c', 'trap "" TERM; sleep 60'], timeoutSeconds: 1 } } } }, dir);
    const t0 = Date.now();
    const r = await cmd.deliver('stub', 'ping', [{ thread: '1', post: null, what: 'x' }], cfg);
    assert.equal(r.ok, false);
    assert.match(r.why, /ran past 1 s/);
    assert.ok(Date.now() - t0 < 12000, 'ended within the grace period');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a resumed tool gets no key-like variables unless its wake passes them', () => {
  const env = resume.wakeEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'k', GH_TOKEN: 't', DB_PASSWORD: 'p', CODEX_THREAD_ID: 'x' }, ['OPENAI_API_KEY']);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'k', CODEX_THREAD_ID: 'x' });
});
