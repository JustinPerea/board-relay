import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestors, lsofInfo } from '../src/proc.mjs';

// A fake process table: pid -> [ppid, executable, open files]
const table = { 30: ['20', '/usr/bin/node', ['/dev/null']], 20: ['10', '/bin/bash', []], 10: ['1', '/opt/tool/bin/devin', ['/h/.local/share/devin/cli/session_locks/amber-field.lock']] };
const lsof = (pid) => {
  const [ppid, exe, files] = table[pid] ?? [];
  if (!ppid) return { stdout: '' };
  return { stdout: [`p${pid}`, `R${ppid}`, 'fcwd', 'n/work', 'ftxt', `n${exe}`, ...files.flatMap((f, i) => [`f${i + 3}`, `n${f}`])].join('\n') + '\n' };
};

test('lsofInfo reads the parent, the executable and the open files', () => {
  const info = lsofInfo('10', (cmd, args) => lsof(args[1]), '/usr/sbin/lsof');
  assert.equal(info.ppid, '1');
  assert.equal(info.exe, '/opt/tool/bin/devin');
  assert.ok(info.files.includes('/h/.local/share/devin/cli/session_locks/amber-field.lock'));
  assert.deepEqual(lsofInfo('99', () => ({ stdout: '' }), '/usr/sbin/lsof').files, []);
  assert.deepEqual(lsofInfo('99', () => { throw new Error('no lsof'); }, '/usr/sbin/lsof').files, []);
});

const bins = { ps: '/bin/ps', lsof: '/usr/sbin/lsof' };
const ps = (pid) => {
  const [ppid, exe] = table[pid] ?? [];
  return { stdout: ppid ? `${ppid} ${exe}\n` : '' };
};

test('where ps is refused, the process tree is walked with lsof, and says whether it reached the top', () => {
  const run = (cmd, args) => (cmd.endsWith('/ps') ? { stdout: '', status: 126 } : lsof(args[1]));
  const chain = ancestors(16, '30', run, bins);
  assert.deepEqual([...chain], [['30', '/usr/bin/node'], ['20', '/bin/bash'], ['10', '/opt/tool/bin/devin']]);
  assert.equal(chain.complete, true);
  const none = ancestors(16, '30', () => ({ stdout: '' }), bins);
  assert.deepEqual([...none], []);
  assert.equal(none.complete, false, 'neither works: incomplete, so a pin check fails closed');
});

test('a walk that stops partway is marked incomplete; ps and lsof are mixed step by step', () => {
  // ps answers for 30 only, lsof for 20 only: the walk can't read 10, so it can't rule out a pinned ancestor there
  const run = (cmd, args) => (cmd.endsWith('/ps') ? (args[3] === '30' ? ps('30') : { stdout: '' }) : (args[1] === '20' ? lsof('20') : { stdout: '' }));
  const chain = ancestors(16, '30', run, bins);
  assert.deepEqual([...chain], [['30', '/usr/bin/node'], ['20', '/bin/bash']]);
  assert.equal(chain.complete, false);
  const calls = [];
  ancestors(16, '30', (cmd, args, opts) => { calls.push([cmd, opts.env.PATH]); return ps(args[3]); }, bins);
  assert.ok(calls.every(([cmd, path]) => cmd === '/bin/ps' && path === '/usr/bin:/bin:/usr/sbin:/sbin'), 'by absolute path, fixed PATH');
});
