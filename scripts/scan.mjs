#!/usr/bin/env node
// Scan the working tree and the whole git history for secrets and personal details before anything is pushed:
// key and token shapes, private key blocks, email addresses, IP addresses, tailnet host names, home-folder paths,
// and any extra terms you list in a file kept outside the repo.
//
//   node scripts/scan.mjs                     tree + history
//   node scripts/scan.mjs --deny ~/deny.txt   also flag each line of that file (case-insensitive)
//
// Exit 1 when anything is found. Each hit prints its place and the rule, never the matched text, so the output
// is safe to paste anywhere. Allowed on purpose: the GitHub noreply address in commit metadata, and example.com.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api key shape', /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20})\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer token', /\bBearer\s+(?!test\b|<|\.\.\.|\$)[A-Za-z0-9._~+/-]{16,}/],
  ['assigned secret', /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ['email', /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|users\.noreply\.github\.com\b|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['ip address', /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['tailnet host', /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i],
  ['home path', /(?:\/Users\/|\/home\/)(?!<|you\b|ada\b|USER\b|\$)[A-Za-z0-9._-]+/],
  ['session id', /\bsession_[A-Za-z0-9]{8,}/],
];

const args = process.argv.slice(2);
const di = args.indexOf('--deny');
const deny = di > -1 ? readFileSync(args[di + 1], 'utf8').split('\n').map((s) => s.trim()).filter((s) => s.length >= 3) : [];
const lower = deny.map((d) => d.toLowerCase());
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });

const hits = [];
function check(where, text) {
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of RULES) if (re.test(line)) hits.push(`${where}:${i + 1}  ${name}`);
    const l = line.toLowerCase();
    lower.forEach((d, k) => { if (l.includes(d)) hits.push(`${where}:${i + 1}  denylist entry ${k + 1}`); });
  });
}

// the tree: tracked files plus untracked ones that aren't ignored
const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  if (text.includes('\0')) { hits.push(`${f}  binary file: check it by eye`); continue; }
  check(f, text);
}

// the history: every commit's metadata and patch
const meta = git('log', '--all', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x01');
for (const rec of meta.split('\x01').map((r) => r.trim()).filter(Boolean)) {
  const [sha, author, committer, body] = rec.split('\0');
  check(`commit ${sha.slice(0, 8)} author`, author.replace(/<[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com>/, '<noreply>'));
  check(`commit ${sha.slice(0, 8)} committer`, committer.replace(/<[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com>/, '<noreply>'));
  check(`commit ${sha.slice(0, 8)} message`, body ?? '');
}
const patches = git('log', '--all', '-p', '--format=commit %H');
let sha = '?';
const added = [];
for (const line of patches.split('\n')) {
  if (line.startsWith('commit ')) sha = line.slice(7, 15);
  else if (line.startsWith('+') && !line.startsWith('+++')) added.push([sha, line.slice(1)]);
}
const bySha = new Map();
for (const [s, l] of added) bySha.set(s, (bySha.get(s) ?? '') + l + '\n');
for (const [s, text] of bySha) check(`history ${s}`, text);

const unique = [...new Set(hits)];
console.log(`scanned ${files.length} files and ${bySha.size} commits with ${RULES.length} rules and ${deny.length} denylist terms`);
if (unique.length) {
  console.log(`${unique.length} hit(s):`);
  for (const h of unique) console.log(`  ${h}`);
  process.exit(1);
}
console.log('no hits');
