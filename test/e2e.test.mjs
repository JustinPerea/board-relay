// End to end: a real `vb serve` on a free port with its own data folder, the relay running in this process, and
// the example agent woken through a command wake. Nothing here touches a board you already run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { Relay } from '../src/relay.mjs';
import { runVb, vbScript } from '../src/vb.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'board-relay-e2e-'));
let serve;
let url;
let relay;
const ac = new AbortController();
let running;

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const person = (args) => runVb(args, { url });
const agent = (as, args) => spawnSync(process.execPath, [join(root, 'bin/agent-board.mjs'), '--as', as, ...args],
  { encoding: 'utf8', env: { ...process.env, BOARD_RELAY_CONFIG: join(dir, 'board-relay.json') } });

async function until(what, fn, ms = 40000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function thread(id) {
  const r = await person(['read', String(id), '--json']);
  const d = JSON.parse(r.stdout);
  return [d.message, ...(d.replies ?? [])];
}

before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}/api/board`;
  serve = spawn(process.execPath, [vbScript(), 'serve', '--port', String(port), '--dir', join(dir, 'board'), '--no-open'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  serve.stdout.on('data', (d) => { out += d; });
  serve.stderr.on('data', (d) => { out += d; });
  try {
    await until('vb serve', () => {
      if (serve.exitCode !== null) throw new Error(`vb serve exited (${serve.exitCode})`);
      return out.includes('serving a local board');
    }, 20000);
  } catch (error) {
    throw new Error(`${error.message}. Its output:\n${out}`);
  }

  writeFileSync(join(dir, 'lead-inbox.sh'), `#!/bin/sh\ncat >> "${join(dir, 'lead-inbox.txt')}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'board-relay.json'), JSON.stringify({
    board: url,
    owner: 'Ada',
    fallback: 'lead',
    stateDir: join(dir, 'state'),
    agentCommand: `node ${join(root, 'bin/agent-board.mjs')}`,
    timing: { quietSeconds: 1, maxHoldSeconds: 3 },
    agents: {
      scribe: { wake: { type: 'command', argv: [process.execPath, join(root, 'examples/scribe.mjs')] } },
      lead: { wake: { type: 'command', argv: [join(dir, 'lead-inbox.sh')] } },
      away: { wake: { type: 'claude-session', name: 'Nobody Here', configDirs: [join(dir, 'no-claude')] } },
    },
  }));
  const file = join(dir, 'board-relay.json');
  const setup = spawnSync(process.execPath, [join(root, 'bin/board-relay.mjs'), 'setup', '--config', file],
    { encoding: 'utf8', timeout: 60000 });
  assert.equal(setup.status, 0, `board-relay setup: ${setup.error ?? ''} ${setup.signal ?? ''}\n${setup.stdout}${setup.stderr}`);
  relay = new Relay(loadConfig(file), { configFile: file });
  running = relay.run({ signal: ac.signal });
  // The relay starts at the board's head on its first run. Give the event stream a moment to open.
  await new Promise((r) => setTimeout(r, 1500));
});

after(async () => {
  ac.abort();
  await running?.catch(() => {});
  // a board that already exited never sends 'close' again: waiting for it hung the whole file
  if (serve && serve.exitCode === null && serve.signalCode === null) {
    const closed = new Promise((r) => serve.once('close', r));
    serve.kill('SIGINT');
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
    if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
});

test('the person mentions an agent: it is pinged, the post gets a bell, and the agent answers in the thread', async () => {
  const r = await person(['post', 'lanes', '@scribe what is in here?']);
  assert.equal(r.code, 0, r.stderr);
  const id = r.stdout.trim().split(/\s+/)[0];
  // The bell goes on after the wake returns, and a command wake like scribe's has already replied by then: wait
  // for both, or a slow machine reads the thread between the two.
  const msgs = await until('scribe to reply and the bell receipt', async () => {
    const m = await thread(id);
    return m.some((x) => x.by?.profile === 'scribe') && Object.keys(m[0].reactions ?? {}).length > 0 && m;
  });
  assert.match(msgs.find((x) => x.by?.profile === 'scribe').text, /scribe here: I read #/);
});

test('a handoff: the agent it is for does it, and the agent that asked hears it completed', async () => {
  const r = agent('lead', ['tasks', 'create', 'handoffs', 'Lead: scribe, tidy the notes', '--for', 'scribe']);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim().split(/\s+/)[0];
  await until('the task to complete', async () => (await thread(id))[0].task?.state === 'completed');
  const inbox = await until('lead to be told', () => existsSync(join(dir, 'lead-inbox.txt'))
    && readFileSync(join(dir, 'lead-inbox.txt'), 'utf8').includes(`task #${id}: \`scribe\` completed the task you made`)
    && readFileSync(join(dir, 'lead-inbox.txt'), 'utf8'));
  assert.ok(!inbox.includes('tidy the notes'), 'the ping holds numbers, not the task text');
});

test('an agent that is away: the thread is told, the ping waits, and the fallback hears about it', async () => {
  await person(['post', 'lanes', 'hello']); // a first post so a mention by handle reaches a known profile
  const r = await person(['post', 'lanes', '@away are you there?']);
  const id = r.stdout.trim().split(/\s+/)[0];
  const msgs = await until('the relay to say so', async () => {
    const m = await thread(id);
    return m.some((x) => x.by?.profile === 'relay' && /`away` was not pinged/.test(x.text)) && m;
  });
  assert.match(msgs.find((x) => x.by?.profile === 'relay').text, /hold the ping until `away` is back/);
  await until('the ping to be saved as waiting', () => {
    try {
      return JSON.parse(readFileSync(join(dir, 'state', 'state.json'), 'utf8')).pending.some((p) => p.agent === 'away');
    } catch { return false; }
  });
  await until('the fallback to be told', () => existsSync(join(dir, 'lead-inbox.txt'))
    && readFileSync(join(dir, 'lead-inbox.txt'), 'utf8').includes('`away` on the board and the ping was not delivered'));
});

test('agent-board refuses to write as the person or to another board', () => {
  assert.equal(agent('ada', ['post', 'lanes', 'x']).status, 2);
  assert.equal(agent('scribe', ['post', 'lanes', 'x', '--url', 'https://example.com/api/board']).status, 2);
  const none = spawnSync(process.execPath, [join(root, 'bin/agent-board.mjs'), 'post', 'lanes', 'x'],
    { encoding: 'utf8', env: { ...process.env, BOARD_RELAY_CONFIG: join(dir, 'board-relay.json'), BOARD_PROFILE: '' } });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /No profile/);
});
