import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyTheme, buildSettings, scriptJson } from '../src/theme/apply.mjs';
import { GLYPH_NAMES } from '../src/theme/glyphs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = dirname(createRequire(import.meta.url).resolve('@vercel/board/package.json'));

const config = () => ({
  owner: 'Ada',
  channels: { asks: 'decisions' },
  agents: {
    lead: { theme: { hue: 250, glyph: 'spark', style: 'holo' } },
    scribe: { theme: { hue: 150, glyph: 'pen' } },
    codex: { tool: true },
  },
});

let dir, bundle, original;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-relay-theme-'));
  cpSync(pkgDir, join(dir, 'board'), { recursive: true, dereference: true });
  bundle = join(dir, 'board/dist/inspect/app.js');
  // the installed copy may already carry a theme (board-relay theme apply): start from its pristine original
  if (existsSync(bundle + '.orig')) cpSync(bundle + '.orig', bundle);
  rmSync(bundle + '.orig', { force: true });
  original = readFileSync(bundle);
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('applyTheme', () => {
  it('applies, and the themed bundle passes node --check', async () => {
    const r = await applyTheme({ mode: 'apply', config: config(), bundlePath: bundle });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.changed, true);
    const text = readFileSync(bundle, 'utf8');
    assert.match(text, /board-relay-theme:begin/);
    assert.match(text, /window\.__boardRelayTheme = \{/);
    execFileSync(process.execPath, ['--check', bundle]);
    assert.ok(!existsSync(join(dir, 'board/dist/inspect/app.next.js')));
    assert.deepEqual(readFileSync(bundle + '.orig'), original);
  });

  it('check reports current after apply, and stale for a different config', async () => {
    assert.equal((await applyTheme({ mode: 'check', config: config(), bundlePath: bundle })).ok, true);
    const other = config();
    other.agents.scribe.theme.hue = 10;
    assert.equal((await applyTheme({ mode: 'check', config: other, bundlePath: bundle })).ok, false);
  });

  it('applying twice changes nothing the second time', async () => {
    const first = readFileSync(bundle);
    const r = await applyTheme({ mode: 'apply', config: config(), bundlePath: bundle });
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.deepEqual(readFileSync(bundle), first);
  });

  it('re-applying with a new config rebuilds from the original, not on top of the old theme', async () => {
    const c = config();
    c.agents.scribe.theme.hue = 10;
    await applyTheme({ mode: 'apply', config: c, bundlePath: bundle });
    assert.equal(readFileSync(bundle, 'utf8').split('board-relay-theme:begin').length, 2);
    await applyTheme({ mode: 'apply', config: config(), bundlePath: bundle });
  });

  it('remove restores the original byte for byte', async () => {
    const r = await applyTheme({ mode: 'remove', bundlePath: bundle });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.changed, true);
    assert.deepEqual(readFileSync(bundle), original);
    assert.equal((await applyTheme({ mode: 'check', config: config(), bundlePath: bundle })).ok, false);
  });

  it('does not touch the installed bundle by default path in these tests', () => {
    assert.notEqual(bundle, join(pkgDir, 'dist/inspect/app.js'));
  });
});

describe('config validation', () => {
  const bad = (mutate, pattern) => {
    const c = config();
    mutate(c);
    assert.throws(() => buildSettings(c), pattern);
  };
  it('rejects a bad hue', () => {
    bad((c) => { c.agents.scribe.theme.hue = 361; }, /hue/);
    bad((c) => { c.agents.scribe.theme.hue = -1; }, /hue/);
    bad((c) => { c.agents.scribe.theme.hue = '120'; }, /hue/);
    bad((c) => { c.agents.scribe.theme.hue = NaN; }, /hue/);
  });
  it('rejects an unknown glyph', () => bad((c) => { c.agents.scribe.theme.glyph = 'x"}body{'; }, /glyph/));
  it('rejects two holo agents', () => bad((c) => { c.agents.scribe.theme.style = 'holo'; }, /only one/));
  it('rejects a holo tool', () => bad((c) => { c.agents.codex.theme = { style: 'holo' }; c.agents.lead.theme.style = undefined; }, /tool/));
  it('applyTheme returns ok:false instead of throwing', async () => {
    const c = config();
    c.agents.scribe.theme.hue = 999;
    const r = await applyTheme({ mode: 'apply', config: c, bundlePath: bundle });
    assert.equal(r.ok, false);
    assert.match(r.message, /hue/);
    assert.deepEqual(readFileSync(bundle), original);
  });
  it('escapes </script> and line separators in the owner name', async () => {
    const c = config();
    c.owner = 'x</script><script>alert(1)</script>  ';
    assert.ok(!scriptJson(buildSettings(c)).includes('<'));
    const r = await applyTheme({ mode: 'apply', config: c, bundlePath: bundle });
    assert.equal(r.ok, true, r.message);
    const text = readFileSync(bundle, 'utf8');
    const themed = text.slice(text.indexOf('board-relay-theme:begin'));
    assert.ok(!themed.includes('</script>'));
    assert.ok(!themed.includes(' ') && !themed.includes(' '));
    assert.match(themed, /\\u003c\/script>/);
    execFileSync(process.execPath, ['--check', bundle]);
    await applyTheme({ mode: 'remove', bundlePath: bundle });
    assert.deepEqual(readFileSync(bundle), original);
  });
});

describe('page.js', () => {
  const page = readFileSync(join(root, 'src/theme/page.js'), 'utf8');
  it('draws exactly the glyphs glyphs.mjs lists', () => {
    const block = page.slice(page.indexOf('const GLYPHS = {'), page.indexOf('const PROFILES'));
    const keys = [...block.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), [...GLYPH_NAMES].sort());
  });
  it('carries no third-party logos and no personal references', () => {
    assert.ok(!/data-bl|LOGOS|base64/.test(page));
    assert.ok(!/\/Users\/|\/home\//.test(page));
  });
});

describe('defaults', () => {
  it('uses the relay\'s default asks channel when the config leaves it out', () => {
    assert.equal(buildSettings({ agents: {} }).asks, 'decisions');
  });
});
