// Agents waking agents with posts: the route, each limit, the tool opt-in, and the relay putting them together.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, ConfigError, AGENT_POSTS } from '../src/config.mjs';
import { routeAgentPost, causedByTool } from '../src/route.mjs';
import * as limits from '../src/limits.mjs';
import { pingText } from '../src/ping.mjs';
import { Relay } from '../src/relay.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const PERSON = { actor: 'local:user:ada', principal: 'local:user:ada', profile: null };
const as = (p) => ({ actor: `local:user:ada+${p}`, principal: 'local:user:ada', profile: p });
const post = (id, by, extra = {}) => ({ id: String(id), channel: 'lanes', text: '', re: null, replyTo: null, labels: {}, by, deleted: false, ...extra });
const ev = (message, type = 'message.posted') => ({ cursor: message.id, type, message, payload: { by: message.by } });

const agents = () => ({
  lead: { wake: { type: 'claude-session', name: 'Lead' } },
  scribe: { wake: { type: 'command', argv: ['node', 'x.mjs'] } },
  helper: { wake: { type: 'command', argv: ['node', 'y.mjs'] } },
  hook: { tool: true, wake: { type: 'webhook', url: 'https://example.com/h' } },
  eager: { tool: true, wakeOnAgentPosts: true, wake: { type: 'webhook', url: 'https://example.com/e' } },
});
const cfg = normalize({ owner: 'Ada', agents: agents() }, '/tmp');
const thread = (...msgs) => Object.fromEntries(msgs.map((m) => [m.id, m]));

// ---------------------------------------------------------------- config

test('config: agentPosts defaults, tools opt out by default, bad values refused', () => {
  assert.deepEqual(cfg.agentPosts, AGENT_POSTS);
  assert.deepEqual(AGENT_POSTS, { enabled: true, perThread: 6, cooldownSeconds: 60, perHour: 30 });
  assert.equal(cfg.agents.scribe.wakeOnAgentPosts, true);
  assert.equal(cfg.agents.hook.wakeOnAgentPosts, false);
  assert.equal(cfg.agents.eager.wakeOnAgentPosts, true);
  const bad = (raw) => assert.throws(() => normalize({ agents: agents(), ...raw }, '/tmp'), ConfigError);
  bad({ agentPosts: { perThread: 0 } });
  bad({ agentPosts: { perHour: 2.5 } });
  bad({ agentPosts: { cooldownSeconds: -1 } });
  bad({ agentPosts: { enabled: 'yes' } });
  bad({ agentPosts: { perThred: 3 } });
  assert.throws(() => normalize({ agents: { x: { wakeOnAgentPosts: 'no', wake: { type: 'command', argv: ['true'] } } } }, '/tmp'), ConfigError);
  assert.equal(normalize({ agents: agents(), agentPosts: { cooldownSeconds: 0 } }, '/tmp').agentPosts.cooldownSeconds, 0);
});

// ---------------------------------------------------------------- route

test('route: an agent\'s @mention wakes the agents it names, never itself', () => {
  const m = post(1, as('lead'), { text: '@scribe and @helper, results in #4. cc @lead' });
  const out = routeAgentPost(ev(m), thread(m), cfg);
  assert.deepEqual(out.map(([a]) => a), ['scribe', 'helper']);
  assert.deepEqual(out[0][1], { thread: '1', post: '1', what: '`lead` mentioned you', who: 'lead', kind: 'agent' });
});

test('route: an agent\'s reply to another agent\'s post wakes that agent', () => {
  const root = post(1, PERSON, { text: 'thoughts?' });
  const theirs = post(2, as('scribe'), { re: '1' });
  const mine = post(3, as('lead'), { re: '1', replyTo: '2' });
  const out = routeAgentPost(ev(mine), thread(root, theirs, mine), cfg);
  assert.deepEqual(out.map(([a, i]) => [a, i.what]), [['scribe', '`lead` replied to your post #2']]);
});

test('route: an agent\'s reply in another agent\'s thread wakes the owner, but not in a task\'s thread', () => {
  const root = post(1, as('lead'), { text: 'what changed in the release?' });
  const answer = post(2, as('scribe'), { re: '1' });
  assert.deepEqual(routeAgentPost(ev(answer), thread(root, answer), cfg).map(([a]) => a), ['lead']);
  const task = post(5, as('lead'), { channel: 'handoffs', task: { state: 'claimed' } });
  const progress = post(6, as('scribe'), { re: '5', channel: 'handoffs' });
  assert.deepEqual(routeAgentPost(ev(progress), thread(task, progress), cfg), []);
  // its own thread: nobody
  const own = post(3, as('lead'), { re: '1' });
  assert.deepEqual(routeAgentPost(ev(own), thread(root, own), cfg), []);
});

test('route: what agent posts wake nobody', () => {
  const none = (m, extra = {}, c = cfg) => assert.deepEqual(routeAgentPost(ev(m, extra.type), thread(m), c), [], JSON.stringify(m));
  none(post(1, as('lead'), { text: '@scribe', channel: 'handoffs' }));   // a task's root: its task events route it
  none(post(1, as('lead'), { text: '@scribe', channel: 'decisions' }));  // a card for the person
  none(post(1, as('lead'), { text: '@scribe' }), { type: 'message.edited' });
  none(post(1, as('lead'), { text: '@scribe', schedule: { id: 's1' } }));
  none(post(1, as('stranger'), { text: '@scribe' }));                     // not a configured agent
  none(post(1, as('relay'), { text: '@scribe' }));
  none(post(1, PERSON, { text: '@scribe' }));                             // a person's post goes through route()
  none(post(1, as('lead'), { text: '@scribe', deleted: true }));
  none(post('x', as('lead'), { text: '@scribe' }));
  none(post(1, as('lead'), { text: '@scribe' }), {}, normalize({ agents: agents(), agentPosts: { enabled: false } }, '/tmp'));
});

test('route: a tool\'s post is still a tool\'s doing, so tools don\'t wake each other through it', () => {
  const m = post(1, as('hook'), { text: '@eager' });
  const [[, item]] = routeAgentPost(ev(m), thread(m), cfg);
  assert.equal(causedByTool(item, cfg), true);
});

// ---------------------------------------------------------------- limits

const L = { enabled: true, perThread: 6, cooldownSeconds: 60, perHour: 30 };
const it = (thread, who) => ({ thread: String(thread), who, kind: 'agent' });

test('limits: a thread takes perThread wakes, then says so once and wakes nobody', () => {
  const st = limits.emptyLimits();
  const agentsInTurn = ['scribe', 'helper', 'lead'];
  for (let i = 0; i < 6; i++) assert.equal(limits.admit(st, agentsInTurn[i % 3], it(1, agentsInTurn[(i + 1) % 3]), L, i).ok, true, `wake ${i + 1}`);
  assert.deepEqual(limits.admit(st, 'scribe', it(1, 'helper'), L, 7), { ok: false, why: 'thread', notice: true });
  assert.deepEqual(limits.admit(st, 'scribe', it(1, 'helper'), L, 8), { ok: false, why: 'thread', notice: false });
  assert.equal(limits.admit(st, 'scribe', it(2, 'helper'), L, 9).ok, true, 'another thread has its own count');
});

test('limits: answering the agent that just woke you counts double', () => {
  const st = limits.emptyLimits();
  assert.equal(limits.admit(st, 'scribe', it(1, 'lead'), L, 0).ok, true);   // lead wakes scribe: 1
  assert.equal(limits.admit(st, 'lead', it(1, 'scribe'), L, 1).ok, true);   // scribe answers lead: 3
  assert.equal(limits.admit(st, 'scribe', it(1, 'lead'), L, 2).ok, true);   // 5
  assert.equal(st.threads['1'].count, 5);
  assert.equal(limits.admit(st, 'lead', it(1, 'scribe'), L, 3).ok, false);  // 7 > 6
  assert.equal(st.threads['1'].capped, true);
});

test('limits: a person acting in the thread starts its count again', () => {
  const st = limits.emptyLimits();
  for (let i = 0; i < 7; i++) limits.admit(st, 'scribe', it(1, i % 2 ? 'lead' : 'helper'), L, i);
  assert.equal(limits.admit(st, 'scribe', it(1, 'lead'), L, 10).ok, false);
  limits.personActed(st, 1);
  assert.equal(limits.admit(st, 'scribe', it(1, 'lead'), L, 11).ok, true);
});

test('limits: at most perHour wakes across the board in an hour, said once an hour per thread', () => {
  const st = limits.emptyLimits();
  const hourly = { ...L, perHour: 3 };
  for (let i = 0; i < 3; i++) assert.equal(limits.admit(st, 'scribe', it(10 + i, 'lead'), hourly, 1000 * i).ok, true);
  assert.deepEqual(limits.admit(st, 'scribe', it(20, 'lead'), hourly, 5000), { ok: false, why: 'hour', notice: true });
  assert.deepEqual(limits.admit(st, 'helper', it(20, 'lead'), hourly, 6000), { ok: false, why: 'hour', notice: false });
  assert.equal(limits.admit(st, 'scribe', it(20, 'lead'), hourly, 3600 * 1000 + 1).ok, true, 'the first wake left the window');
});

test('limits: cooldown holds pings from agents\' posts, not one with a person\'s', () => {
  const st = limits.emptyLimits();
  const agentItems = [it(1, 'lead')];
  assert.equal(limits.due(st, 'scribe', agentItems, L, 0), true);
  limits.sent(st, 'scribe', agentItems, 0);
  assert.equal(limits.due(st, 'scribe', agentItems, L, 59_000), false);
  assert.equal(limits.due(st, 'scribe', [...agentItems, { thread: '2', post: '9', what: 'reply' }], L, 59_000), true);
  assert.equal(limits.due(st, 'scribe', agentItems, L, 60_000), true);
  limits.sent(st, 'helper', [{ thread: '2', post: '9', what: 'reply' }], 0);
  assert.equal(st.woke.helper, undefined, 'a person\'s ping starts no cooldown');
});

test('limits: prune forgets ended cooldowns, the last hour, and threads quiet for a week', () => {
  const st = limits.emptyLimits();
  limits.admit(st, 'scribe', it(1, 'lead'), L, 0);
  limits.sent(st, 'scribe', [it(1, 'lead')], 0);
  limits.prune(st, L, 61_000);
  assert.deepEqual(st.woke, {});
  assert.equal(st.recent.length, 1);
  limits.prune(st, L, 7 * 24 * 3600 * 1000);
  assert.deepEqual(st, limits.emptyLimits());
});

// ---------------------------------------------------------------- ping

test('ping: an agent\'s post is the agent\'s word, with the limit and how to answer', () => {
  const text = pingText('scribe', [it(4, 'lead')].map((i) => ({ ...i, post: '7', what: '`lead` mentioned you' })), 'now', cfg);
  assert.match(text, /Another agent wrote to you on the board \(now\):/);
  assert.match(text, /thread #4: `lead` mentioned you \(the post is #7\)/);
  assert.match(text, /never stands in for Ada's yes/);
  assert.match(text, /after 6 wakes until Ada posts there/);
  assert.match(text, /agent-board --as scribe reply 4 "<your answer>"/);
  assert.doesNotMatch(text, /Task news|Ada wrote to you/);
});

// ---------------------------------------------------------------- relay

function setup(raw = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ap-'));
  dirs.push(dir);
  const c = normalize({ owner: 'Ada', agents: agents(), stateDir: 'state', ...raw }, dir);
  const store = {};
  const rec = { replies: [], labels: [] };
  const board = {
    add: (m) => { store[m.id] = m; },
    readThread: async (id) => ({ ok: true, messages: Object.fromEntries(Object.entries(store).filter(([k, m]) => k === String(id) || String(m.re) === String(id))) }),
    waitingOn: async () => [],
    reply: async (thread, text) => { rec.replies.push({ thread: String(thread), text }); },
    react: async () => {},
    label: async (...a) => { rec.labels.push(a); },
  };
  const calls = [];
  const ok = (agent, items) => { calls.push({ agent, items }); return { ok: true }; };
  const t = { now: 1_700_000_000_000 };
  const relay = new Relay(c, {
    board, clock: () => t.now, note: () => {},
    adapters: {
      claude: { deliver: async (agent, text) => ok(agent, [{ text }]), reachable: () => true },
      command: { deliver: async (agent, text, items) => ok(agent, items) },
      webhook: { deliver: async (agent, items) => ok(agent, items) },
      resume: { recordedSession: async () => ({ why: 'none' }), startWake: async () => { throw new Error('no'); }, checkWakes: async () => false },
    },
  });
  const feed = async (m) => { store[m.id] = m; return relay.onEvent(ev(m)); };
  const flush = async (ms = 7000) => { t.now += ms; await relay.flushHeld(); };
  return { relay, rec, calls, t, feed, flush, cfg: c };
}

test('relay: an agent mentioning another wakes it, and marks no card answered', async () => {
  const s = setup();
  await s.feed(post(1, as('lead'), { text: '@scribe the benchmark is in #3' }));
  await s.flush();
  assert.deepEqual(s.calls.map((c) => c.agent), ['scribe']);
  assert.equal(s.calls[0].items[0].kind, 'agent');
  const reply = post(2, as('lead'), { re: '1', replyTo: null, text: '@scribe one more' });
  await s.feed(reply);
  s.t.now += 61_000;
  await s.flush();
  assert.deepEqual(s.rec.labels, [], 'an agent\'s reply is not a person answering a card');
});

test('relay: a tool that hasn\'t opted in is not woken, and the thread is told once', async () => {
  const s = setup();
  await s.feed(post(1, as('lead'), { text: '@hook please run it' }));
  await s.feed(post(2, as('lead'), { re: '1', text: '@hook again' }));
  await s.flush();
  assert.deepEqual(s.calls, []);
  assert.equal(s.rec.replies.length, 1);
  assert.match(s.rec.replies[0].text, /`hook` is a tool.*wakeOnAgentPosts.*make a task for it/);
  // one that opted in is woken by a session agent, but not by another tool
  await s.feed(post(3, as('lead'), { text: '@eager please run it' }));
  await s.feed(post(4, as('hook'), { text: '@eager and you' }));
  await s.flush();
  assert.deepEqual(s.calls.map((c) => [c.agent, c.items.map((i) => i.who)]), [['eager', ['lead']]]);
});

test('relay: two agents answering each other stop at the thread limit, told once; a person\'s post resets it', async () => {
  const s = setup({ agentPosts: { cooldownSeconds: 0 } });
  await s.feed(post(1, PERSON, { text: 'lead and scribe, sort out the schema' }));
  let id = 2;
  let last = null;
  for (let i = 0; i < 6; i++) {
    const who = i % 2 ? 'scribe' : 'lead';
    const other = i % 2 ? 'lead' : 'scribe';
    const m = post(id++, as(who), { re: '1', replyTo: last, text: `@${other} turn ${i}` });
    await s.feed(m);
    last = m.id;
    await s.flush();
  }
  // lead→scribe 1, scribe→lead 3, lead→scribe 5, then capped
  assert.deepEqual(s.calls.map((c) => c.agent), ['scribe', 'lead', 'scribe']);
  const notices = s.rec.replies.filter((r) => /as often as the relay allows/.test(r.text));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].thread, '1');
  await s.feed(post(id++, PERSON, { re: '1', text: 'carry on' }));
  await s.feed(post(id++, as('lead'), { re: '1', text: '@scribe go' }));
  await s.flush();
  assert.equal(s.calls.filter((c) => c.agent === 'scribe' && c.items.some((i) => i.kind === 'agent')).length, 3);
});

test('relay: the cooldown holds a second agent ping, and a person\'s post releases it', async () => {
  const s = setup();
  await s.feed(post(1, as('lead'), { text: '@scribe first' }));
  await s.flush();
  await s.feed(post(2, as('helper'), { text: '@scribe second' }));
  await s.flush(); // 7 s after the first: in the cooldown
  assert.equal(s.calls.length, 1);
  await s.feed(post(3, PERSON, { text: '@scribe from Ada' }));
  await s.flush();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1].items.map((i) => i.kind ?? 'person'), ['agent', 'person']);
});

test('relay: a cooldown hold survives a forced flush and a restart', async () => {
  const s = setup();
  await s.feed(post(1, as('lead'), { text: '@scribe first' }));
  await s.flush();
  await s.feed(post(2, as('lead'), { text: '@scribe second' }));
  await s.relay.flushHeld(true);
  assert.equal(s.calls.length, 1, 'still in the cooldown');
  s.relay.save();
  const again = new Relay(s.cfg, { board: s.relay.board, clock: () => s.t.now, note: () => {}, adapters: s.relay.adapters });
  again.load();
  assert.equal(again.held.scribe.items.length, 1);
  assert.ok(again.state.agentPosts.woke.scribe);
  s.t.now += 61_000;
  await again.flushHeld();
  assert.equal(s.calls.length, 2);
});

test('relay: an old state file with no agentPosts loads', () => {
  const s = setup();
  fs.mkdirSync(s.cfg.stateDir, { recursive: true });
  fs.writeFileSync(path.join(s.cfg.stateDir, 'state.json'), JSON.stringify({ cursor: '5', held: {}, inflight: [], pending: [] }));
  s.relay.load();
  assert.deepEqual(s.relay.state.agentPosts, limits.emptyLimits());
});
