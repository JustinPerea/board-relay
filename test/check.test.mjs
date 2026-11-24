import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('board-relay check warns about a missing folder, program or headers file, and still lists the agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-check-'));
  try {
    const file = join(dir, 'board-relay.json');
    writeFileSync(file, JSON.stringify({ agents: {
      ok: { wake: { type: 'command', argv: ['node', '-e', '0'] } },
      tool: { tool: true, wake: { type: 'resume', enabled: false, argv: ['no-such-tool-xyz', '{session}'], sessionEnv: 'X',
        sessionPattern: '^[a-z]+$', cwd: join(dir, 'missing') } },
      hook: { tool: true, wake: { type: 'webhook', enabled: false, url: 'https://example.com/h', headersFile: join(dir, 'h.json') } },
    } }));
    const r = spawnSync(process.execPath, [resolve('bin/board-relay.mjs'), '--config', file, 'check'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /tool .*resume, turned off\n.*warning: the folder .*missing does not exist\n.*warning: `no-such-tool-xyz` is not on PATH/);
    assert.match(r.stdout, /warning: the headers file .*h\.json does not exist yet/);
    assert.doesNotMatch(r.stdout.split('\n').filter((l) => l.includes(' ok ')).join('\n'), /warning/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
