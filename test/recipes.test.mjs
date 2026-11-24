// The config blocks in docs/recipes.md load as written, and their session patterns match the ids and files the
// tools were seen to use, so the recipes can't drift from the config format unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/config.mjs';
import { ownSession } from '../src/guard.mjs';

const doc = readFileSync(new URL('../docs/recipes.md', import.meta.url), 'utf8');

function recipes() {
  const agents = {};
  const pin = [];
  for (const [, block] of doc.matchAll(/```json\n([\s\S]*?)```/g)) {
    const b = block.trim();
    if (b.startsWith('{ "permissions"')) continue;
    const d = JSON.parse(`{${b.replace("https://<the routine's webhook URL>", 'https://example.com/hook')}}`);
    pin.push(...(d.pin ?? []));
    delete d.pin;
    Object.assign(agents, d);
  }
  return normalize({ agents, pin }, '/tmp');
}

test('every recipe in docs/recipes.md loads as a config', () => {
  const cfg = recipes();
  assert.deepEqual(Object.keys(cfg.agents).sort(), ['codex', 'cursor', 'devin', 'devin-cloud', 'grok', 'hermes']);
  for (const [name, a] of Object.entries(cfg.agents)) {
    assert.equal(a.tool, true, name);
    if (a.wake) assert.equal(a.wake.enabled, false, `${name} starts with its wake off`);
  }
  assert.equal(cfg.pins.length, 1);
});

test('the Cursor and Devin recipes find the session ids the tools were seen to hold open', () => {
  const cfg = recipes();
  const chain = [['20', 'bash'], ['10', 'tool']];
  const holds = (path) => ({ chain, files: (pid) => (pid === '10' ? ['/dev/null', path] : []) });
  const cursorId = '7c0e5a1d-2b3f-4c6d-9e8f-0a1b2c3d4e5f';
  assert.equal(ownSession('cursor', cfg, {}, holds(`/h/.cursor/chats/${'a1'.repeat(16)}/${cursorId}/store.db`)), cursorId);
  assert.equal(ownSession('devin', cfg, {}, holds('/h/.local/share/devin/cli/session_locks/quiet-harbor.lock')), 'quiet-harbor');
  assert.equal(ownSession('hermes', cfg, { HERMES_SESSION_ID: '20261120_101500_0a1b2c3d' }), '20261120_101500_0a1b2c3d');
  assert.equal(ownSession('hermes', cfg, { HERMES_SESSION_ID: 'my title' }), null);
});
