// The lowest Node version is stated in several places. They all match package.json's engines, and CI runs that
// exact version. vb serve declares 22.18 but stalls on 22.18 and 22.19, so a copied number would be wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const floor = JSON.parse(read('package.json')).engines.node.match(/^>=(\d+\.\d+)$/)?.[1];

test('package.json states the floor as >=major.minor', () => assert.ok(floor));

test('the lockfile root, README, AGENTS.md and CI all state the same floor', () => {
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].engines.node, `>=${floor}`);
  const readme = read('README.md');
  assert.ok(readme.includes(`alt="Node ${floor} or later"`), 'README badge alt text');
  assert.ok(readme.includes(`%E2%89%A5${floor}-`), 'README badge URL');
  assert.ok(readme.includes(`You need Node ${floor} or later`), 'README quickstart');
  assert.match(read('AGENTS.md'), new RegExp(`node --version +# ${floor.replace('.', '\\.')} or later`));
  assert.match(read('.github/workflows/test.yml'), new RegExp(`node: \\['${floor.replace('.', '\\.')}\\.0',`));
});

test('no other Node 22 minor is named as a floor in the docs', () => {
  for (const f of ['README.md', 'AGENTS.md', 'docs/reference.md', 'docs/recipes.md', 'ARCHITECTURE.md']) {
    for (const m of read(f).matchAll(/Node (22\.\d+)(?:\+| or later)/g)) assert.equal(m[1], floor, `${f}: ${m[0]}`);
  }
});
