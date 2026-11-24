// agent-board's rules. Plain `vb` has two defaults that are wrong for agents on a shared local board:
//
//   1. With no URL it talks to the hosted board of whatever Vercel team the folder is linked to.
//   2. With no profile it writes as the person. An agent that forgets `--as` leaves a post that reads as theirs.
//
// So agent-board always points at the configured board, refuses any flag that would point elsewhere, and refuses
// to run without an agent profile. It is a guard rail for well-meaning agents, not a security boundary: anything
// that can run `vb` or reach the port directly can skip it.
//
// Everything in this file is pure; bin/agent-board.mjs does the I/O.
import { PROFILE_RE } from './config.mjs';

export const SCHEMA = 'decision@1';
export const RISKS = ['none', 'money', 'public', 'irreversible', 'security'];
const NOT_BLOCKING = new Set(['nothing', 'none', 'no', 'nothing is blocked', 'nothing blocked']);

// Flags that pick a board other than the configured one.
export const ELSEWHERE = ['--url', '--scope', '--team', '--name', '--ensure'];
// Commands an agent has no reason to run on a shared board.
export const REFUSED = {
  serve: 'The board is already running; starting or restarting it is for the person who runs it.',
  hooks: 'It edits agent settings files. Settings changes are for the person who runs the board.',
  hook: 'It is the turn-end hook an older board installed.',
  grants: 'Grants decide who may do what on the board. Changing them is for the person who runs it.',
  sync: 'A local board has no sync to Slack, GitHub or Linear.',
  sources: 'A local board has no sync to Slack, GitHub or Linear.',
  inbox: 'A local board has no sync to Slack, GitHub or Linear.',
  inspect: 'It opens a browser. The page is already served by vb serve.',
  conformance: 'It writes test traffic into the board.',
  list: 'It lists a Vercel team\'s hosted boards.',
  ls: 'It lists a Vercel team\'s hosted boards.',
};
// Every command vb 0.56 has. The command is the first of these on the line, so a flag's value can't hide it.
export const KNOWN = new Set(['whoami', 'grants', 'channels', 'schemas', 'actors', 'read', 'post', 'reply', 'schedule',
  'schedules', 'edit', 'delete', 'react', 'label', 'typing', 'sync', 'inbox', 'sources', 'download', 'conformance',
  'tasks', 'hooks', 'hook', 'tail', 'wait', 'help', 'serve', 'inspect', 'list', 'ls', 'ask', 'session']);
const NO_PROFILE_NEEDED = new Set(['help', '--help', '-h', '--version', 'whoami']);
const VALUE_FLAGS = new Set(['--label', '--for', '--file', '--idempotency-key', '--lease', '--wait', '--from', '--state',
  '--attach', '--schema', '--re', '--by', '--after', '--before', '--channel', '--text', '--last', '--limit', '--in', '--at',
  '--every', '--until', '--times', '--timeout', '--source', '--mentions', '--if', '--if-unset', '--unset', '--avatar']);

export function refuse(msg, fix) {
  return `agent-board: refused. ${msg}\n  ${fix}`;
}

/** {argv without --as, profile, command}. Stops at `--` (what follows is `tasks run`'s own command). */
export function parse(argv, env = {}) {
  let profile = env.BOARD_PROFILE || null;
  let command = null;
  let first = null;
  const rest = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (a === '--as' || a.startsWith('--as=')) {
      profile = a.includes('=') ? a.slice(5) : (argv[i + 1] ?? '');
      if (!a.includes('=')) i++;
      continue;
    }
    if (VALUE_FLAGS.has(a)) { // its value is never the command: `--idempotency-key whoami post ...`
      rest.push(a);
      if (i + 1 < argv.length) rest.push(argv[++i]);
      continue;
    }
    if (!a.startsWith('-')) {
      if (first === null) first = a;
      if (command === null && KNOWN.has(a)) command = a;
    }
    rest.push(a);
  }
  // command: the first known command word (so `--port 4101 serve` is still seen as serve). first: the first word
  // that isn't a flag or a flag's value, which is what vb itself runs.
  return { argv: [...rest, ...argv.slice(i)], profile, command, first };
}

const HELP_FLAGS = new Set(['--help', '-h']);

function noProfileNeeded(args) {
  if (args.length === 0) return true;
  if (args.length === 1) return NO_PROFILE_NEEDED.has(args[0]);
  if (args.length !== 2) return false;
  const [a, b] = args;
  return (a === 'help' && KNOWN.has(b)) || (KNOWN.has(a) && HELP_FLAGS.has(b));
}

/** Error text, or null when the call may go ahead. */
export function decide(argv, env, cfg, { pinned = null } = {}) {
  const { argv: args, profile, command, first } = parse(argv, env);
  for (const a of args) {
    if (a === '--') break;
    const flag = a.split('=')[0];
    if (ELSEWHERE.includes(flag))
      return refuse(`${flag} points at a board other than the configured one.`, `Drop ${flag}: agent-board always uses ${cfg.board}.`);
  }
  if (first && REFUSED[first] && !REFUSED[command]) return refuse(`\`${first}\` is not for agents. ${REFUSED[first]}`, 'If it is needed, the person who runs the board runs it.');
  if (command && REFUSED[command]) return refuse(`\`${command}\` is not for agents. ${REFUSED[command]}`, 'If it is needed, the person who runs the board runs it.');
  const hasCard = args.some((x) => x.includes(`json#${SCHEMA}`));
  const intoAsks = positionals(args).includes(cfg.asks);
  if (intoAsks && !hasCard && (command === 'post' || command === 'schedule' || (command === 'tasks' && args.includes('create'))))
    return refuse(`A question for ${cfg.owner} in ${cfg.asks} is a decision card, not free text.`,
      'Use `agent-board --as <you> ask "The question?" --recommend ... --yes ... --no ... --blocking ... --risk ...` (see `agent-board ask --help`).');
  // Only these exact shapes run without a profile: help, version or whoami on their own, `help <command>`, and
  // `<command> --help`. Anything longer needs one, since a flag the guard doesn't know could take the next word
  // as its value and vb would run something other than what the guard read.
  if (noProfileNeeded(args)) return null;
  if (!profile) return refuse(`No profile, so this would be recorded as ${cfg.owner}'s own word.`, 'Name yourself: add `--as <your-agent-name>` or set BOARD_PROFILE.');
  if (!PROFILE_RE.test(profile)) return refuse(`\`${profile}\` is not a valid profile name.`, 'Use a letter first, then up to 31 letters, numbers or hyphens.');
  const p = profile.toLowerCase();
  if (cfg.people.has(p)) return refuse(`\`${profile}\` names the person, not an agent.`, 'Use your own agent name.');
  if (p === cfg.relay) return refuse(`\`${profile}\` is the relay's own profile.`, 'Use your own agent name.');
  if (pinned && pinned !== p) return refuse(`This process runs under a tool that may only write as \`${pinned}\`.`, `Use \`--as ${pinned}\`.`);
  if (command === 'label' && args.some((a) => /^session=/.test(a)))
    return refuse('The session label is set by agent-board itself, from the running tool.', 'Leave it out.');
  return handoffCheck(args, command, cfg);
}

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

/** A task in a handoff channel names the agent it is for, and that agent is one the relay knows: the board itself
 *  takes any name after --for, and the task then waits for nobody. */
export function handoffCheck(args, command, cfg, readPlan = null) {
  if (command !== 'tasks') return null;
  const pos = positionals(args);
  const sub = pos[1];
  if (sub !== 'create' && sub !== 'assign') return null;
  const named = [];
  let plan = null;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].includes('=') ? [args[i].slice(0, args[i].indexOf('=')), args[i].slice(args[i].indexOf('=') + 1)] : [args[i], null];
    if (flag === '--for' || flag === '--file') {
      const v = inline ?? args[i + 1] ?? '';
      if (inline === null) i++;
      if (flag === '--for') named.push(v);
      else plan = v;
    }
  }
  const inHandoffs = sub === 'create' && cfg.handoffs.includes(pos[2]);
  if (sub === 'assign' && pos[3]) named.push(pos[3]);
  const list = Object.keys(cfg.agents).sort().join(', ');
  if (plan !== null) {
    if (!readPlan) return null; // checked again by the caller, which can read the file
    if (plan === '-' && inHandoffs) return refuse('A plan read from stdin can\'t have its agent names checked.', 'Write the plan to a file and pass `--file <path>`.');
    if (plan !== '-') {
      let entries;
      try { entries = readPlan(plan); } catch (error) { return refuse(`The plan file ${plan} can't be read as JSON (${error.message}).`, 'Fix the file and run it again.'); }
      for (const [k, entry] of (Array.isArray(entries) ? entries : []).entries()) {
        if (entry?.for) named.push(String(entry.for));
        else if (inHandoffs) return refuse(`Task ${k + 1} in the plan names no agent, so nobody would be woken for it.`, `Give each task a "for": one of ${list}.`);
      }
    }
  } else if (inHandoffs && !named.length) {
    return refuse('A handoff task names the agent it is for, so the relay can wake that agent.', `Add \`--for <agent>\`: one of ${list}.`);
  }
  for (const who of named)
    if (!cfg.agents[who.toLowerCase()]) return refuse(`\`${who}\` is not an agent the relay knows, so the task would wait for nobody.`, `Use one of: ${list}, or add it to the relay's config.`);
  return null;
}

/** `schedules --by <agent>` lists nothing: the board wants the full handle, `<user>/<agent>`. */
export function expandBy(argv, command, user) {
  if (command !== 'schedules' && command !== 'read' && command !== 'tail' && command !== 'wait') return argv;
  const fix = (v) => (v.includes('/') || v.includes(':') || v === 'me' ? v : `${user}/${v}`);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--by' && i + 1 < argv.length) { out.push(a, fix(argv[++i])); continue; }
    out.push(a.startsWith('--by=') ? `--by=${fix(a.slice(5))}` : a);
  }
  return out;
}

/** The writes that carry a session label, so the relay can resume the tool that wrote them. */
export function sessionWrite(argv, command) {
  if (command === 'post' || command === 'reply') return true;
  const pos = positionals(argv);
  return command === 'tasks' && pos[1] === 'create';
}

/** argv with any caller-given session label removed and the tool's own added (when it has one). */
export function withSession(argv, sid) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.push(...argv.slice(i)); break; }
    if (a === '--label' && /^session=/.test(argv[i + 1] ?? '')) { i++; continue; }
    if (/^--label=session=/.test(a)) continue;
    out.push(a);
  }
  if (!sid) return out;
  const dash = out.indexOf('--');
  const add = ['--label', `session=${sid}`];
  return dash === -1 ? [...out, ...add] : [...out.slice(0, dash), ...add, ...out.slice(dash)];
}

/** The tool's own session id for a profile with a resume wake, read from its environment; null when there is none
 *  or it has the wrong shape. */
export function ownSession(profile, cfg, env, { chain = [], files = () => [] } = {}) {
  try {
    const wake = cfg.agents[profile]?.wake;
    if (!wake || wake.type !== 'resume') return null;
    let sid = null;
    if (wake.sessionEnv) sid = env[wake.sessionEnv];
    else if (wake.sessionOpenFile) {
      // A tool that keeps no id in its shell's environment (Cursor, Devin) holds a file named after the session
      // open while a turn runs. Exactly one distinct id among the files this process tree holds counts.
      const found = new Set();
      for (const [pid] of chain) for (const f of files(pid)) {
        const m = wake.sessionOpenFile.exec(f);
        if (m?.[1]) found.add(m[1]);
      }
      if (found.size === 1) [sid] = found;
    }
    return typeof sid === 'string' && wake.sessionPattern.test(sid) ? sid : null;
  } catch {
    return null; // a failed lookup leaves the post without a label; it never stops the post
  }
}

/** The one profile this process tree may use, or null. chain: [[pid, command path]] from this process up. */
export function pinnedProfile(chain, cfg) {
  for (const { process: re, profile } of cfg.pins) if (chain.some(([, comm]) => re.test(comm))) return profile;
  return null;
}

// ---------------------------------------------------------------- decision cards

// A yes approves the whole "If yes" line. Deleting and spending are easy to add to that line in passing ("... then
// delete the old archive") and hard to take back, so the line may hold one only when the card shows it: in the
// question, as --risk, or as --also.
const SECOND = {
  irreversible: ['deletes or overwrites something', /\b(delet\w*|eras\w*|wip(?:e|es|ed|ing)|purg\w*|overwrit\w*|force[- ]push\w*|destroy\w*)/i],
  money: ['spends money', /(\$\s?\d[\d,.]*|\b(?:pay|pays|paid|paying|buy|buys|buying|purchas\w*|spend\w*)\b)/i],
};
// What the "If yes" line says the agent will do to shared code or a live system. A marker for the list, not a check.
const DOES = [['merges', 'merge'], ['pushes', 'push'], ['deploys', '(?:re)?deploy']];
const NOT_DOING = /\b(?:no|not|never|without|before|until|unless|separately|won't|don't|can't|cannot)(?![\w'])(?:\W+\w+){0,4}\W*$/i;

export function does(ifYes) {
  const found = [];
  for (const [word, verb] of DOES) {
    for (const sentence of String(ifYes ?? '').split(/(?<=[.;!?])\s+/)) {
      const m = new RegExp(`(?:\\bI\\b(.*?)|^\\W*())\\b(?:${verb})\\b`, 'i').exec(sentence);
      if (m && !NOT_DOING.test(m[1] ?? '')) { found.push(word); break; }
    }
  }
  return found;
}

/** {text, labels} for a decision card; throws Error saying what to fix. */
export function card({ ask, recommend, ifYes, ifNo, blocking, risk, answerWith, evidence, also = [] }) {
  ask = String(ask ?? '').trim();
  if (!/^[^\n]{4,200}\?$/.test(ask)) throw new Error('the question is one line, at most 200 characters, ending in "?"');
  const data = { recommend, if_yes: ifYes, if_no: ifNo, blocking, risk };
  const limits = { recommend: 300, if_yes: 300, if_no: 300, blocking: 200 };
  const flag = { if_yes: 'yes', if_no: 'no' };
  for (const [key, limit] of Object.entries(limits)) {
    const v = String(data[key] ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (v.length < 2 || v.length > limit) throw new Error(`--${flag[key] ?? key} needs 2 to ${limit} characters (it has ${v.length}). Put the detail behind --evidence.`);
    data[key] = v;
  }
  if (!RISKS.includes(risk)) throw new Error(`--risk is one of: ${RISKS.join(', ')} (the most serious one that applies)`);
  const extra = RISKS.filter((r) => also.includes(r));
  if (extra.length !== new Set(also).size || extra.includes('none') || extra.includes(risk))
    throw new Error(`--also names a further risk: one of ${RISKS.slice(1).filter((r) => r !== risk).join(', ')}, not the same as --risk`);
  if (extra.length && risk === 'none') throw new Error('--also needs a --risk other than none: put the most serious one in --risk');
  for (const [kind, [what, pattern]] of Object.entries(SECOND)) {
    const found = pattern.exec(data.if_yes);
    if (found && kind !== risk && !extra.includes(kind) && !pattern.test(ask))
      throw new Error(`the "If yes" line also ${what} ("${found[0]}"), and neither the question nor --risk shows it. A yes approves the `
        + `whole line. Take it out and ask it as its own card, or add --also ${kind} so the card shows it.`);
  }
  if (answerWith) data.answer_with = String(answerWith).split(/\s+/).join(' ').slice(0, 120);
  if (evidence) data.evidence = String(evidence).split(/\s+/).join(' ').slice(0, 400);
  const text = `${ask}\n\n\`\`\`json#${SCHEMA}\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  const labels = { kind: 'decision', blocking: NOT_BLOCKING.has(data.blocking.toLowerCase().replace(/\.$/, '')) ? 'no' : 'yes', risk };
  if (extra.length) labels.also = extra.join('-');
  const d = does(data.if_yes);
  if (d.length) labels.does = d.join('-');
  return { text, labels };
}
