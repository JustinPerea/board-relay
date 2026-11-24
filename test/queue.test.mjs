import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as q from '../src/queue.mjs';

const item = (thread, extra = {}) => ({ thread: String(thread), post: null, what: 'x', ...extra });

test('a repeat schedule keeps one waiting ping: the latest send', () => {
  const s = q.emptyState();
  q.holdScheduled(s, 'lead', [item(1, { kind: 'schedule', schedule: 's1', n: 0 })], 1000);
  q.holdScheduled(s, 'lead', [item(2, { kind: 'schedule', schedule: 's1', n: 1 })], 2000);
  q.holdScheduled(s, 'lead', [item(3, { kind: 'schedule', schedule: 's2', n: 0 })], 3000);
  const all = s.pending.flatMap((p) => p.items);
  assert.deepEqual(all.map((i) => i.thread).sort(), ['2', '3']);
});

test('a closed task drops what waits about it, except its own closing news and scheduled posts', () => {
  const s = q.emptyState();
  q.enqueue(s, 'lead', [item(7), item(8)], 'away', 0);
  q.enqueue(s, 'scribe', [item(7, { closes: true }), item(7, { kind: 'schedule', schedule: 's1' })], 'away', 0);
  q.enqueue(s, 'builder', [item(7)], 'away', 0);
  const dropped = q.dropClosed(s, '7');
  assert.deepEqual(dropped.map(([a]) => a).sort(), ['builder', 'lead']);
  assert.deepEqual(s.pending.map((p) => [p.agent, p.items.length]), [['lead', 1], ['scribe', 2]]);
});

test('dropClosedHeld does the same for pings still being gathered', () => {
  const held = { lead: { items: [item(7)], first: 0, last: 0 }, scribe: { items: [item(7), item(9)], first: 0, last: 0 } };
  q.dropClosedHeld(held, 7);
  assert.deepEqual(Object.keys(held), ['scribe']);
  assert.deepEqual(held.scribe.items.map((i) => i.thread), ['9']);
});

test('what waits for an agent removed from the config goes only after the grace period', () => {
  const s = q.emptyState();
  q.enqueue(s, 'gone', [item(1)], 'away', 0);
  assert.deepEqual(q.pruneGone(s, {}, 1000, 600), []);
  assert.equal(s.pending.length, 1);
  assert.deepEqual(q.pruneGone(s, {}, 1000 + 600 * 1000, 600), ['gone']);
  assert.equal(s.pending.length, 0);
  assert.deepEqual(s.goneSince, {});
});

test('an agent that comes back into the config before the grace period keeps its pings', () => {
  const s = q.emptyState();
  q.enqueue(s, 'lead', [item(1)], 'away', 0);
  q.pruneGone(s, {}, 1000, 600);
  q.pruneGone(s, { lead: {} }, 5000, 600);
  q.pruneGone(s, {}, 700 * 1000, 600);
  assert.equal(s.pending.length, 1, 'the clock restarts when it leaves again');
});

test('age alone never drops anything', () => {
  const s = q.emptyState();
  q.enqueue(s, 'lead', [item(1)], 'away', 0);
  q.pruneGone(s, { lead: {} }, 365 * 86400 * 1000, 600);
  assert.equal(s.pending.length, 1);
});

test('backoff doubles from the retry gap up to the cap', () => {
  const p = { tried: 0 };
  const gaps = [];
  for (let i = 0; i < 8; i++) {
    q.backOff(p, 0, 120, 3600);
    gaps.push(p.wait / 1000);
  }
  assert.deepEqual(gaps, [240, 480, 960, 1920, 3600, 3600, 3600, 3600]);
  assert.equal(q.nextTry(p, 120), 3600 * 1000);
  assert.equal(q.nextTry({ tried: 5000 }, 120), 125000);
});

test('threads are grouped by the session that wrote in them', () => {
  const sids = { 1: 'a', 2: 'b', 3: 'a', 4: null };
  const groups = q.groupBySession([item(1), item(2), item(3), item(4)], (t) => sids[t]);
  assert.deepEqual(groups.map((g) => g.map((i) => i.thread)), [['1', '3'], ['2'], ['4']]);
});

test('waitingLines: one line per agent, oldest first', () => {
  const s = q.emptyState();
  q.enqueue(s, 'scribe', [item(5)], 'busy', 60 * 60000);
  q.enqueue(s, 'lead', [item(1), item(2)], 'has no live session right now', 0);
  const lines = q.waitingLines(s, 2 * 3600000, 120);
  assert.match(lines[0], /^lead: 2 waiting, oldest 2 h, threads #1, #2 \(has no live session right now\)$/);
  assert.match(lines[1], /^scribe: 1 waiting, oldest 1 h/);
});
