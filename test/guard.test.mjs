import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/config.mjs';
import { card, decide, does, expandBy, handoffCheck, ownSession, parse, pinnedProfile, withSession } from '../src/guard.mjs';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const cfg = normalize({
  owner: 'Ada',
  ownerNames: ['ada-l'],
  agents: {
    lead: { wake: { type: 'claude-session', name: 'Lead' } },
    scribe: { wake: { type: 'command', argv: ['true'] } },
    codex: { tool: true, wake: { type: 'resume', argv: ['codex', 'exec', 'resume', '{session}', '-'], sessionEnv: 'CODEX_THREAD_ID', sessionPattern: UUID, cwd: '/tmp' } },
  },
  pin: [{ process: '/CloudBot\\.app/', profile: 'cloudbot' }],
}, '/tmp');

const refused = (argv, env = {}, opts) => decide(argv, env, cfg, opts);

test('no profile is refused; whoami and help need none', () => {
  assert.match(refused(['post', 'lanes', 'hi']), /No profile/);
  assert.equal(refused(['whoami']), null);
  assert.equal(refused(['--help']), null);
  assert.equal(refused([]), null);
  assert.equal(refused(['post', 'lanes', 'hi'], { BOARD_PROFILE: 'scribe' }), null);
});

test('flags that point at another board are refused, even with =', () => {
  for (const f of ['--url', '--scope', '--team', '--name', '--ensure'])
    assert.match(refused(['--as', 'scribe', 'read', 'lanes', f, 'x']), new RegExp(`${f} points at a board`));
  assert.match(refused(['--as', 'scribe', 'read', 'lanes', '--url=http://x']), /--url points/);
});

test('the person\'s names, the relay\'s profile and bad names are refused', () => {
  for (const p of ['ada', 'Ada', 'ada-l', 'me', 'human', 'owner']) assert.match(refused(['--as', p, 'post', 'lanes', 'x']), /names the person/);
  assert.match(refused(['--as', 'relay', 'post', 'lanes', 'x']), /relay's own profile/);
  assert.match(refused(['--as', '9lives', 'post', 'lanes', 'x']), /not a valid profile/);
  assert.match(refused(['--as=', 'post', 'lanes', 'x']), /No profile/);
});

test('commands that change the board or settings are refused', () => {
  for (const c of ['serve', 'hooks', 'grants', 'sync', 'conformance', 'inspect', 'list'])
    assert.match(refused(['--as', 'scribe', c]), /is not for agents/);
  assert.match(refused(['--as', 'scribe', '--port', '4101', 'serve']), /`serve` is not for agents/);
});

test('free text into the asks channel is refused; a card is not', () => {
  assert.match(refused(['--as', 'scribe', 'post', 'decisions', 'should I?']), /decision card/);
  assert.match(refused(['--as', 'scribe', 'tasks', 'create', 'decisions', 'should I?']), /decision card/);
  assert.match(refused(['--as', 'scribe', 'schedule', 'decisions', 'later?', '--in', '1h']), /decision card/);
  assert.equal(refused(['--as', 'scribe', 'post', 'decisions', 'q?\n```json#decision@1\n{}\n```']), null);
  assert.equal(refused(['--as', 'scribe', 'read', 'decisions']), null);
});

test('a pinned process tree may write only as its pinned profile', () => {
  const chain = [['10', '/usr/bin/node'], ['9', '/Applications/CloudBot.app/Contents/MacOS/helper']];
  assert.equal(pinnedProfile(chain, cfg), 'cloudbot');
  assert.equal(pinnedProfile([['10', '/bin/zsh']], cfg), null);
  assert.match(refused(['--as', 'lead', 'post', 'lanes', 'x'], {}, { pinned: 'cloudbot' }), /may only write as `cloudbot`/);
  assert.equal(refused(['--as', 'cloudbot', 'post', 'lanes', 'x'], {}, { pinned: 'cloudbot' }), null);
});

test('handoff tasks must name an agent the relay knows', () => {
  const check = (argv, plan) => handoffCheck(parse(argv).argv, 'tasks', cfg, plan ? () => plan : null);
  assert.match(check(['--as', 'lead', 'tasks', 'create', 'handoffs', 'do it']), /names the agent it is for/);
  assert.match(check(['--as', 'lead', 'tasks', 'create', 'handoffs', 'do it', '--for', 'nobody']), /`nobody` is not an agent/);
  assert.equal(check(['--as', 'lead', 'tasks', 'create', 'handoffs', 'do it', '--for', 'scribe']), null);
  assert.equal(check(['--as', 'lead', 'tasks', 'create', 'handoffs', 'do it', '--for=Scribe']), null);
  assert.equal(check(['--as', 'lead', 'tasks', 'create', 'lanes', 'my own todo']), null);
  assert.match(check(['--as', 'lead', 'tasks', 'assign', '12', 'ghost']), /`ghost` is not an agent/);
  assert.match(check(['--as', 'lead', 'tasks', 'create', 'handoffs', '--file', 'p.json'], [{ text: 'a' }]), /names no agent/);
  assert.equal(check(['--as', 'lead', 'tasks', 'create', 'handoffs', '--file', 'p.json'], [{ text: 'a', for: 'scribe' }]), null);
  // decide() can't read the plan file, so it leaves the plan to the caller instead of refusing it
  assert.equal(refused(['--as', 'lead', 'tasks', 'create', 'handoffs', '--file', 'p.json']), null);
});

test('a caller can\'t set the session label; the tool\'s own is added from its environment', () => {
  const sid = '0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';
  assert.match(refused(['--as', 'codex', 'label', '12', 'session=abc']), /set by agent-board itself/);
  assert.deepEqual(withSession(['reply', '12', 'hi', '--label', 'session=evil', '--label=session=evil2'], null), ['reply', '12', 'hi']);
  assert.deepEqual(withSession(['reply', '12', 'hi'], sid), ['reply', '12', 'hi', '--label', `session=${sid}`]);
  assert.equal(ownSession('codex', cfg, { CODEX_THREAD_ID: sid }), sid);
  assert.equal(ownSession('codex', cfg, { CODEX_THREAD_ID: '--help' }), null);
  assert.equal(ownSession('scribe', cfg, { CODEX_THREAD_ID: sid }), null);
});

test('--by takes a bare agent name', () => {
  assert.deepEqual(expandBy(['schedules', '--by', 'lead'], 'schedules', 'ada'), ['schedules', '--by', 'ada/lead']);
  assert.deepEqual(expandBy(['schedules', '--by=lead'], 'schedules', 'ada'), ['schedules', '--by=ada/lead']);
  assert.deepEqual(expandBy(['read', 'lanes', '--by', 'me'], 'read', 'ada'), ['read', 'lanes', '--by', 'me']);
});

const base = { ask: 'Ship the docs?', recommend: 'Yes, they are reviewed', ifYes: 'I publish them', ifNo: 'They stay a draft', blocking: 'nothing', risk: 'public' };

test('a card: one question, fields in a decision@1 block, labels for the list', () => {
  const { text, labels } = card(base);
  assert.match(text, /^Ship the docs\?\n\n```json#decision@1\n/);
  assert.deepEqual(labels, { kind: 'decision', blocking: 'no', risk: 'public' });
  assert.equal(card({ ...base, blocking: 'the release' }).labels.blocking, 'yes');
  assert.throws(() => card({ ...base, ask: 'Ship the docs' }), /ending in "\?"/);
  assert.throws(() => card({ ...base, risk: 'maybe' }), /--risk is one of/);
  assert.throws(() => card({ ...base, recommend: 'x' }), /--recommend needs 2 to 300/);
});

test('a card may not slip a delete or a spend into its yes', () => {
  assert.throws(() => card({ ...base, risk: 'none', ifYes: 'I publish, then delete the old archive' }), /deletes or overwrites/);
  assert.throws(() => card({ ...base, risk: 'none', ifYes: 'I buy the domain' }), /spends money/);
  assert.equal(card({ ...base, risk: 'public', also: ['irreversible'], ifYes: 'I publish, then delete the old archive' }).labels.also, 'irreversible');
  assert.ok(card({ ...base, ask: 'Delete the old archive?', risk: 'none', ifYes: 'I delete it' }));
  assert.throws(() => card({ ...base, risk: 'none', also: ['money'] }), /--also needs a --risk/);
});

test('does: what a yes sets in motion, read from the yes line', () => {
  assert.deepEqual(does('I merge it to main and deploy.'), ['merges', 'deploys']);
  assert.deepEqual(does('Merge, then push the tag.'), ['merges']);
  assert.deepEqual(does('I won\'t merge until you look.'), []);
  assert.deepEqual(does('I do not push anything.'), []);
});

test('vb gets --url and --as before a `--`, so a wrapped command can\'t swallow them', async () => {
  const { vbArgv } = await import('../src/vb.mjs');
  const a = vbArgv(['tasks', 'run', '12', '--', 'make', 'test'], 'http://127.0.0.1:4100/api/board', 'scribe');
  assert.deepEqual(a.slice(1), ['tasks', 'run', '12', '--url', 'http://127.0.0.1:4100/api/board', '--as', 'scribe', '--', 'make', 'test']);
  assert.deepEqual(vbArgv(['read', '5'], 'u', 'p').slice(1), ['read', '5', '--url', 'u', '--as', 'p']);
});

test('the messenger prompt fences the text with a per-call tag the text can\'t contain', async () => {
  const { messengerPrompt } = await import('../src/wake/claude-session.mjs');
  const p1 = messengerPrompt('uds:/x.sock', 'hello');
  const p2 = messengerPrompt('uds:/x.sock', 'hello');
  assert.notEqual(p1, p2);
  assert.throws(() => messengerPrompt('uds:/x.sock', 'abc TAG abc', 'TAG'), /contains the marker/);
});

test('a flag\'s value is never taken for the command', () => {
  assert.match(refused(['--idempotency-key', 'whoami', 'post', 'general', 'x']), /No profile/);
  assert.match(refused(['-h', 'post', 'lanes', 'x']), /No profile/);
  assert.match(refused(['--label', 'whoami', 'post', 'lanes', 'x']), /No profile/);
  // a flag the guard doesn't know may take the next word as its value in vb, so whoami must stand alone
  assert.match(refused(['--some-new-flag', 'whoami', 'post', 'lanes', 'x']), /No profile/);
  assert.match(refused(['whoami', 'post', 'lanes', 'x']), /No profile/);
  assert.equal(refused(['help', 'post']), null);
  assert.equal(refused(['post', '--help']), null);
  assert.match(refused(['post', 'lanes', 'x', '--help']), /No profile/);
});

test('another --config can\'t drop a pin: the default configs\' pins still apply', async () => {
  const { allPins } = await import('../src/config.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-pins-'));
  try {
    fs.writeFileSync(path.join(dir, 'board-relay.json'), '{}');
    const pinned = { pins: [{ process: /CloudBot\.app/, profile: 'cloudbot' }] };
    const load = (p) => (p === path.join(dir, 'board-relay.json') ? pinned : { pins: [] });
    const other = { pins: [] }; // the config the caller chose, with no pin
    const pins = allPins(other, path.join(dir, 'elsewhere.json'), { cwd: dir, load });
    assert.equal(pinnedProfile([['9', '/Applications/CloudBot.app/x']], { pins }), 'cloudbot');
    // a default config that fails to load adds nothing and doesn't throw
    assert.deepEqual(allPins(other, path.join(dir, 'x.json'), { cwd: dir, load: () => { throw new Error('bad'); } }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
