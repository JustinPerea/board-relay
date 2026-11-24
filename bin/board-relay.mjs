#!/usr/bin/env node
// board-relay: wake the right agent when a Vercel Board thread or handoff needs it.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, configPath, loadConfig } from '../src/config.mjs';
import { Relay } from '../src/relay.mjs';
import { pingText, when } from '../src/ping.mjs';
import * as queue from '../src/queue.mjs';
import { applyTheme } from '../src/theme/apply.mjs';
import { liveSessions, defaultConfigDirs } from '../src/wake/claude-session.mjs';
import { runVb } from '../src/vb.mjs';

const HELP = `usage: board-relay <command> [--config <file>]

  setup                  create the channels and register the decision card schema (once per board)
  run                    follow the board and wake agents until stopped
  check                  read the config and say what each agent's wake will do
  status                 the saved position, what waits, and running tool wakes
  waiting                one line per agent with pings waiting for it
  ping <agent>           send one marked test ping to an agent, through its wake
  sessions               list the live Claude Code sessions the relay can see
  theme apply|check|remove   colors, glyphs and decision cards on the vb serve page
  init                   copy board-relay.example.json to board-relay.json

The config is --config, else BOARD_RELAY_CONFIG, else ./board-relay.json, else
~/.config/board-relay/board-relay.json.`;

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ci = args.indexOf('--config');
const given = ci > -1 ? args.splice(ci, 2)[1] : null;
const [cmd, ...rest] = args;

function config() {
  const file = configPath(given);
  try {
    return { cfg: loadConfig(file), file };
  } catch (error) {
    console.error(error instanceof ConfigError ? `board-relay: ${error.message}` : error);
    process.exit(2);
  }
}

async function main() {
  switch (cmd) {
    case 'run': {
      const { cfg, file } = config();
      const relay = new Relay(cfg, { configFile: file, note: (m) => { relay.log(m); console.log(m); } });
      const ac = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ac.abort());
      console.log(`board-relay: following ${cfg.board} as ${cfg.relay}; ${Object.keys(cfg.agents).length} agents. Ctrl-C to stop.`);
      try {
        await relay.run({ signal: ac.signal });
      } catch (error) {
        console.error(`board-relay: ${error.message}`);
        return 1;
      }
      return 0;
    }
    case 'setup': {
      // Once per board: the channels the relay uses and the schema decision cards are written in. Both are
      // idempotent on the board's side: an existing channel stays, the same schema again changes nothing.
      const { cfg } = config();
      const run = (a) => runVb(a, { url: cfg.board, as: cfg.relay });
      let bad = 0;
      for (const ch of [cfg.asks, ...cfg.handoffs]) {
        const r = await run(['channels', 'create', ch]);
        console.log(r.code === 0 ? `channel ${ch}: ready` : `channel ${ch}: ${(r.stderr || r.stdout).trim()}`);
        bad += r.code !== 0;
      }
      const r = await run(['schemas', 'create', 'decision@1', '--file', join(here, '..', 'schemas', 'decision.schema.json'),
        '--description', 'A question for the person who runs the board: a recommendation and what a yes and a no set in motion.']);
      console.log(r.code === 0 ? 'schema decision@1: registered' : `schema decision@1: ${(r.stderr || r.stdout).trim()}`);
      return bad || r.code ? 1 : 0;
    }
    case 'check': {
      const { cfg, file } = config();
      console.log(`config  ${file}\nboard   ${cfg.board}\nrelay   writes as ${cfg.relay}; asks channel ${cfg.asks}; handoffs ${cfg.handoffs.join(', ')}`);
      console.log(`fallback ${cfg.fallback ?? '(none: a new post that names no agent wakes nobody)'}`);
      for (const a of Object.values(cfg.agents)) {
        const w = a.wake;
        const how = !w ? 'not woken (no wake)' : !w.enabled ? `${w.type}, turned off`
          : w.type === 'claude-session' ? `Claude Code session ${w.name ? `named "${w.name}"` : ''}${w.cwd ? ` in ${w.cwd}` : ''}`
            : w.type === 'command' ? `runs: ${w.argv.join(' ')}`
              : w.type === 'resume' ? `resumes its session: ${w.argv.join(' ')}`
                : `calls its webhook (${new URL(w.url).host})`;
        console.log(`  ${a.name.padEnd(18)} ${a.tool ? 'tool   ' : 'session'} ${how}`);
        for (const w of setupWarnings(a, file)) console.log(`  ${''.padEnd(18)} warning: ${w}`);
      }
      return 0;
    }
    case 'status':
    case 'waiting': {
      const { cfg } = config();
      const relay = new Relay(cfg);
      const s = relay.load();
      const lines = queue.waitingLines(s, Date.now(), cfg.timing.retrySeconds);
      if (cmd === 'status') {
        console.log(`position ${s.cursor ?? '(not started)'}`);
        for (const w of s.waking) console.log(`waking  ${w.agent} pid ${w.pid} since ${new Date(w.started).toLocaleTimeString()}, threads ${w.threads.join(', ')}`);
      }
      console.log(lines.length ? lines.join('\n') : 'nothing waits');
      return 0;
    }
    case 'ping': {
      const { cfg, file } = config();
      const agent = (rest[0] ?? '').toLowerCase();
      if (!cfg.agents[agent]) { console.error(`board-relay: ${rest[0] ?? '(none)'} is not an agent in the config`); return 2; }
      const relay = new Relay(cfg, { configFile: file });
      const items = [{ thread: '0', post: null, what: 'a test ping from `board-relay ping`; nothing to read, no reply needed' }];
      if (cfg.agents[agent].wake?.type === 'resume') { console.error('board-relay: a resume wake needs a thread; reply to the tool on the board instead'); return 2; }
      const r = await relay.attempt(agent, items);
      console.log(r.ok ? `sent to ${agent}` : `not sent: ${r.why}${r.detail ? `\n${r.detail}` : ''}`);
      if (!r.ok) console.log('\nThe text was:\n' + pingText(agent, items, when(), cfg));
      return r.ok ? 0 : 1;
    }
    case 'sessions': {
      const { cfg } = config();
      const dirs = [...defaultConfigDirs(), ...Object.values(cfg.agents).flatMap((a) => a.wake?.configDirs ?? [])];
      const list = liveSessions([...new Set(dirs)]);
      if (!list.length) console.log(`no live Claude Code sessions with messaging in ${dirs.join(', ')}`);
      for (const s of list) console.log(`${(s.name || '(unnamed)').padEnd(32)} ${s.cwd}`);
      return 0;
    }
    case 'theme': {
      const mode = rest[0] ?? 'apply';
      const file = configPath(given);
      let raw = {};
      if (mode !== 'remove') {
        try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { console.error(`board-relay: can't read ${file}: ${error.message}`); return 2; }
      }
      const r = await applyTheme({ mode, config: raw });
      console.log(r.message);
      return r.ok ? 0 : 1;
    }
    case 'init': {
      const to = join(process.cwd(), 'board-relay.json');
      if (existsSync(to)) { console.error('board-relay: board-relay.json is already here'); return 2; }
      copyFileSync(join(here, '..', 'board-relay.example.json'), to);
      console.log('wrote board-relay.json: edit the agents, then `board-relay check`');
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`board-relay: unknown command ${cmd}\n\n${HELP}`);
      return 2;
  }
}

process.exitCode = await main();

/** What `check` can see is missing for an agent's wake: its folder, its program, its headers file. */
function setupWarnings(agent, file) {
  const w = agent.wake;
  if (!w) return [];
  const out = [];
  if (w.cwd && !existsSync(w.cwd)) out.push(`the folder ${w.cwd} does not exist`);
  if ((w.type === 'resume' || w.type === 'command') && !onPath(w.argv[0], w.cwd ?? dirname(file)))
    out.push(`\`${w.argv[0]}\` is not on PATH`);
  if (w.type === 'webhook' && w.headersFile && !existsSync(w.headersFile)) out.push(`the headers file ${w.headersFile} does not exist yet`);
  return out;
}

function onPath(cmd, cwd) {
  if (cmd.includes('/')) return existsSync(isAbsolute(cmd) ? cmd : join(cwd, cmd));
  return (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, cmd)));
}

