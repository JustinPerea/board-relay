// Every relative link in the repo's Markdown resolves: the file exists, and an
// anchor names a heading in it (slugged the way GitHub slugs headings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = ['README.md', 'AGENTS.md', 'ARCHITECTURE.md',
  ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

// Text outside fenced code blocks and inline code spans.
function prose(text) {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return ''; }
    return inFence ? '' : line.replace(/`[^`]*`/g, '');
  }).join('\n');
}

function slug(heading) {
  return heading.trim().toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(file) {
  const text = readFileSync(file, 'utf8');
  const seen = new Map();
  const out = new Set();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/) || line.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i);
    if (!m) continue;
    const base = slug(m[1].replace(/`/g, ''));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

function links(text) {
  const body = prose(text);
  const found = [];
  for (const m of body.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push(m[1]);
  for (const m of body.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)) found.push(m[1]);
  return found.filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t));
}

test('docs list is not empty', () => {
  assert.ok(docs.includes('docs/reference.md') && docs.includes('docs/recipes.md'));
});

for (const doc of docs) {
  test(`relative links in ${doc} resolve`, () => {
    const from = join(root, doc);
    const problems = [];
    for (const target of links(readFileSync(from, 'utf8'))) {
      const [path, anchor] = target.split('#');
      const file = path ? resolve(dirname(from), decodeURIComponent(path)) : from;
      if (!existsSync(file)) { problems.push(`${target}: no file ${relative(root, file)}`); continue; }
      if (anchor !== undefined && file.endsWith('.md') && !anchors(file).has(anchor)) {
        problems.push(`${target}: no heading #${anchor} in ${relative(root, file)}`);
      }
    }
    assert.deepEqual(problems, []);
  });
}

test('slugs match GitHub for the headings used here', () => {
  assert.equal(slug('Trust and limits'), 'trust-and-limits');
  assert.equal(slug('Claude Code sessions'), 'claude-code-sessions');
  assert.equal(slug('1. Check the basics'), '1-check-the-basics');
  assert.equal(slug('Codex CLI (untested)'), 'codex-cli-untested');
});
