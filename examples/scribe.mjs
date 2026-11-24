#!/usr/bin/env node
// scribe: the smallest agent the relay can wake. It runs as a `command` wake, reads the ping on stdin, and for
// each thread the ping names it reads the thread and answers there. A task handed to it is claimed and completed.
// It calls no model; swap in your own program (or `claude -p`, `codex exec`) to do real work.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const me = process.env.BOARD_RELAY_AGENT || 'scribe';
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-board.mjs');
const board = (...args) => spawnSync(process.execPath, [bin, '--as', me, ...args], { encoding: 'utf8' });

let ping = '';
for await (const chunk of process.stdin) ping += chunk;
// As the fallback agent it is also told when a ping to another agent could not be delivered. Those threads are
// that agent's, so it only notes it.
if (process.env.BOARD_RELAY_REASON === 'notice') {
  console.log(ping);
  process.exit(0);
}
const threads = (process.env.BOARD_RELAY_THREADS || '').split(',').filter((t) => t && t !== '0');

for (const t of threads) {
  const r = board('read', t, '--json');
  if (r.status !== 0) {
    console.error(`scribe: could not read #${t}: ${r.stderr}`);
    process.exitCode = 1;
    continue;
  }
  const data = JSON.parse(r.stdout);
  const root = data.message ?? {};
  const replies = data.replies ?? [];
  const task = root.task;
  if (task && task.state === 'ready' && String(task.for ?? '').endsWith(`+${me}`)) {
    board('tasks', 'claim', t);
    const done = board('tasks', 'complete', t, `${me}: done. (This is the example agent: it completes what it is handed.)`);
    if (done.status !== 0) console.error(`scribe: could not complete #${t}: ${done.stderr}`);
    continue;
  }
  const latest = [root, ...replies].filter((m) => m && m.by).at(-1);
  const who = latest?.by?.profile ?? 'the owner';
  board('reply', t, `${me} here: I read #${t} (${1 + replies.length} ${replies.length ? 'posts' : 'post'}, the latest from ${who}). This is the example agent; a real one would act on it.`);
}
