#!/usr/bin/env node
// agent-board: how agents use the board. Every vb command works, with three differences:
//   it always talks to the board in the relay's config, it refuses to run without `--as <agent>`,
//   and a question for the person goes in as a decision card: `agent-board --as <agent> ask ...`.
// See README.md, "agent-board".
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { ConfigError, configPath, loadConfig } from '../src/config.mjs';
import { RISKS, card, decide, expandBy, ownSession, parse, pinnedProfile, sessionWrite, withSession } from '../src/guard.mjs';
import { handoffCheck } from '../src/guard.mjs';
import { vbArgv, vbEnv } from '../src/vb.mjs';

function ancestors(limit = 16) {
  const out = [];
  let pid = String(process.pid);
  for (let i = 0; i < limit; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', pid], { encoding: 'utf8', timeout: 3000 });
    const line = (r.stdout ?? '').trim();
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) break;
    out.push([pid, m[2]]);
    if (m[1] === '0' || m[1] === '1') break;
    pid = m[1];
  }
  return out;
}

function vb(args, profile) {
  return spawnSync(process.execPath, vbArgv(args, cfg.board, profile), { env: vbEnv(), stdio: 'inherit' }).status ?? 1;
}

function vbCapture(args, profile) {
  return spawnSync(process.execPath, vbArgv(args, cfg.board, profile), { env: vbEnv(), encoding: 'utf8' });
}

let cfg;
try {
  // --config is read only as the first argument, so post text or a wrapped command's `--config` is never taken
  const given = process.argv[2] === '--config' ? process.argv[3] : null;
  if (given) process.argv.splice(2, 2);
  cfg = loadConfig(configPath(given));
} catch (error) {
  console.error(error instanceof ConfigError ? `agent-board: ${error.message}` : error);
  process.exit(2);
}
if (cfg.allowRemoteBoard) {
  console.error('agent-board: refused. The config sets allowRemoteBoard, and agent-board only writes to a board on this machine.');
  process.exit(2);
}

const argv = process.argv.slice(2);
const pinned = cfg.pins.length ? pinnedProfile(ancestors(), cfg) : null;
const err = decide(argv, process.env, cfg, { pinned });
if (err) {
  console.error(err);
  process.exit(2);
}
let { argv: args, profile, command } = parse(argv, process.env);
profile = profile?.toLowerCase() ?? null;

// tasks create/assign --file: check the plan's agent names too
if (command === 'tasks') {
  const planErr = handoffCheck(args, command, cfg, (p) => JSON.parse(readFileSync(p, 'utf8')));
  if (planErr) {
    console.error(planErr);
    process.exit(2);
  }
}

if (command === 'session') {
  const sid = profile ? ownSession(profile, cfg, process.env) : null;
  console.log(sid ? `session=${sid}` : 'no session label: this profile has no resume wake, or its session variable is unset');
  if (pinned) console.log(`this process tree may write only as ${pinned}`);
  process.exit(0);
}

if (command === 'ask') process.exit(ask(args.slice(args.indexOf('ask') + 1), profile));

args = expandBy(args, command, userInfo().username);
if (profile && sessionWrite(args, command)) args = withSession(args, ownSession(profile, cfg, process.env));
if (profile && !cfg.agents[profile] && command === 'tasks' && args.includes('create'))
  console.error(`agent-board: \`${profile}\` is not in the relay's config, so nothing on this task will wake you.`);
process.exit(vb(args, profile));

function ask(rest, who) {
  const help = `usage: agent-board --as <agent> ask "The question?" --recommend <text> --yes <text> --no <text>
         --blocking <text|nothing> --risk ${RISKS.join('|')} [--also <risk>] [--answer-with "A / B"]
         [--evidence <link>] [--attach <file>] [--replace <id>] [--dry-run]

Puts a question to ${cfg.owner} as a decision card in ${cfg.asks}. One decision per card.`;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: {
      recommend: { type: 'string' }, yes: { type: 'string' }, no: { type: 'string' }, blocking: { type: 'string' },
      risk: { type: 'string' }, also: { type: 'string', multiple: true }, 'answer-with': { type: 'string' },
      evidence: { type: 'string' }, attach: { type: 'string', multiple: true }, replace: { type: 'string' },
      'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
  } catch (error) {
    console.error(`agent-board ask: ${error.message}\n\n${help}`);
    return 2;
  }
  const o = parsed.values;
  if (o.help) { console.log(help); return 0; }
  for (const k of ['recommend', 'yes', 'no', 'blocking', 'risk']) {
    if (!o[k]) { console.error(`agent-board ask: --${k} is required\n\n${help}`); return 2; }
  }
  let built;
  try {
    built = card({ ask: parsed.positionals.join(' '), recommend: o.recommend, ifYes: o.yes, ifNo: o.no, blocking: o.blocking,
      risk: o.risk, answerWith: o['answer-with'], evidence: o.evidence, also: o.also ?? [] });
  } catch (error) {
    console.error(`agent-board ask: ${error.message}`);
    return 2;
  }
  const labels = { ...built.labels, from: who };
  const sid = ownSession(who, cfg, process.env);
  if (sid) labels.session = sid; // so the answer can resume the tool's session
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  if (o['dry-run']) { console.log(`${built.text}\n\nlabels: ${pairs.join(' ')}`); return 0; }
  const flags = pairs.flatMap((p) => ['--label', p]);
  const run = (a) => {
    const r = vbCapture(a, who);
    if (r.status !== 0) process.stderr.write((r.stdout ?? '') + (r.stderr ?? ''));
    return r;
  };
  if (o.replace) {
    if (o.attach) { console.error('agent-board ask: --replace keeps the post\'s files; add one with `reply <id> --attach`.'); return 2; }
    const stale = ['also', 'does'].filter((k) => !(k in labels)).flatMap((k) => ['--unset', k]);
    if (run(['edit', o.replace, built.text]).status !== 0) return 1;
    if (run(['label', o.replace, ...pairs, ...stale, '--unset', 'replied']).status !== 0) return 1;
    console.log(`#${o.replace} is now a decision card`);
    return 0;
  }
  let number;
  if (o.attach?.length) {
    const r = run(['post', cfg.asks, built.text, ...flags, ...o.attach.flatMap((f) => ['--attach', f])]);
    if (r.status !== 0) return 1;
    number = r.stdout.trim().split(/\s+/)[0];
    if (run(['tasks', 'create', number]).status !== 0) return 1;
  } else {
    const r = run(['tasks', 'create', cfg.asks, built.text, ...flags]);
    if (r.status !== 0) return 1;
    number = r.stdout.trim().split(/\s+/)[0];
  }
  console.log(`#${number} asked. ${cfg.owner} answers in the thread.`);
  if (!cfg.agents[who])
    console.error(`agent-board ask: \`${who}\` is not in the relay's config, so the answer will NOT wake you. Check the thread yourself: agent-board --as ${who} read ${number}`);
  return 0;
}
