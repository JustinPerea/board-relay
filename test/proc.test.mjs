import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestors, lsofInfo, openFiles } from '../src/proc.mjs';

// A fake process table: pid -> [ppid, executable, open files]
const table = { 30: ['20', '/usr/bin/node', ['/dev/null']], 20: ['10', '/bin/bash', []], 10: ['1', '/opt/tool/bin/devin', ['/h/.local/share/devin/cli/session_locks/amber-field.lock']] };
const lsof = (pid) => {
  const [ppid, exe, files] = table[pid] ?? [];
  if (!ppid) return { stdout: '' };
  return { stdout: [`p${pid}`, `R${ppid}`, 'fcwd', 'n/work', 'ftxt', `n${exe}`, ...files.flatMap((f, i) => [`f${i + 3}`, `n${f}`])].join('\n') + '\n' };
};

test('lsofInfo reads the parent, the executable and the open files', () => {
  const info = lsofInfo('10', (cmd, args) => lsof(args[1]));
  assert.equal(info.ppid, '1');
  assert.equal(info.exe, '/opt/tool/bin/devin');
  assert.ok(info.files.includes('/h/.local/share/devin/cli/session_locks/amber-field.lock'));
  assert.deepEqual(openFiles('99', () => ({ stdout: '' })), []);
  assert.deepEqual(openFiles('99', () => { throw new Error('no lsof'); }), []);
});

test('where ps is refused, the process tree is walked with lsof', () => {
  const run = (cmd, args) => (cmd === 'ps' ? { stdout: '', status: 126 } : lsof(args[1]));
  assert.deepEqual(ancestors(16, '30', run), [['30', '/usr/bin/node'], ['20', '/bin/bash'], ['10', '/opt/tool/bin/devin']]);
  assert.deepEqual(ancestors(16, '30', () => ({ stdout: '' })), [], 'neither works: empty, so pins fail closed');
});
