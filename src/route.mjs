// Who to wake for one board event. Everything here is pure: events and threads in, (agent, item) pairs out.
// test/route.test.mjs runs these rules against made-up events.
import { isPerson, profileOf, PROFILE_RE } from './config.mjs';

const MENTION_ID = /@\[local:user:[^\]\s+]+\+([A-Za-z][A-Za-z0-9-]*)\]/g;
const MENTION_HANDLE = /(?<![\w/])@(?:[a-z0-9._-]+\/)?([A-Za-z][A-Za-z0-9-]*)/g;

export const CLOSING = ['task.completed', 'task.failed', 'task.canceled'];
const TASK_WORDS = {
  'task.unblocked': 'unblocked', 'task.completed': 'completed', 'task.canceled': 'canceled',
  'task.failed': 'marked failed', 'task.reopened': 'reopened', 'task.assigned': 'reassigned',
};

/** Agents named in a text, in order: the board's stored form and a typed @handle. */
export function mentions(text, agents) {
  const found = [];
  for (const rx of [MENTION_ID, MENTION_HANDLE]) {
    for (const m of String(text ?? '').matchAll(rx)) {
      const name = m[1].toLowerCase();
      if (agents[name] && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

const profile = (by) => String(by?.profile ?? '').toLowerCase();

// Ids from the board go into pings and into vb's argv, so only plain numbers are routed.
export const ID_RE = /^\d{1,15}$/;
const SCHEDULE_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** The agent that owns a thread: its root's `from=` label, else the root's author. */
export function ownerOf(root) {
  return String(root?.labels?.from ?? root?.by?.profile ?? '').toLowerCase();
}

/**
 * The person's own doing: [targets, item], or [null, null] when the event is not theirs.
 *
 * 1. the author of the post they replied to, when that author is an agent, and every agent they @mention;
 * 2. otherwise the agent that owns the thread;
 * 3. otherwise the fallback agent, when the config names one.
 *
 * thread: {message id: message} for the event's thread, root included.
 */
export function route(event, thread, cfg) {
  const kind = event?.type ?? '';
  const msg = event?.message ?? {};
  const payload = event?.payload ?? {};
  const rootId = String(msg.re ?? msg.id ?? '');
  const root = thread[rootId] ?? (msg.re ? {} : msg);
  // The from= label is board text anyone can write: it names an owner only when it names a configured agent.
  const owner = cfg.agents[ownerOf(root)] ? ownerOf(root) : '';
  if (!ID_RE.test(rootId)) return [null, null];

  if (kind === 'message.posted' || kind === 'message.edited') {
    if (!ID_RE.test(String(msg.id))) return [null, null];
    if (!isPerson(msg.by) || msg.deleted) return [null, null];
    const targets = [];
    const replied = thread[String(msg.replyTo ?? '')];
    // a reply to a post by a profile that is not an agent (the relay's own lines, say) goes on to the owner
    if (replied && cfg.agents[profile(replied.by)]) targets.push(profile(replied.by));
    for (const name of mentions(msg.text, cfg.agents)) if (!targets.includes(name)) targets.push(name);
    if (!targets.length && msg.re && owner && owner !== cfg.relay) targets.push(owner);
    if (!targets.length && cfg.fallback) targets.push(cfg.fallback);
    if (!targets.length) return [null, null];
    const what = kind === 'message.edited' ? 'edited post' : msg.re ? 'reply' : 'new post';
    return [targets, { thread: rootId, post: String(msg.id), what }];
  }

  if (TASK_WORDS[kind]) {
    if (!isPerson(payload.by)) return [null, null];
    const target = owner && owner !== cfg.relay ? owner : cfg.fallback;
    if (!target) return [null, null];
    return [[target], { thread: rootId, post: null, what: `task ${TASK_WORDS[kind]}`, event: kind }];
  }
  return [null, null];
}

/**
 * [(agent, item)] for a task event that agents or the board caused in a handoff channel, plus, in any channel
 * and whoever caused it, a failed or canceled task told to the agents whose tasks still wait on it.
 *
 * dependents: [[task id, its agent]] for tasks waiting on this one; the caller looks them up. Nobody is told
 * about their own action.
 */
export function routeHandoff(event, dependents, cfg) {
  const kind = event?.type ?? '';
  const msg = event?.message ?? {};
  const payload = event?.payload ?? {};
  const gone = kind === 'task.failed' || kind === 'task.canceled';
  const person = isPerson(payload.by);
  const handoff = cfg.handoffs.includes(msg.channel) && !person;
  if (!kind.startsWith('task.') || !(handoff || gone)) return [];
  const task = msg.task ?? {};
  const tid = String(payload.id ?? msg.id ?? '');
  if (!ID_RE.test(tid)) return [];
  const who = person ? cfg.owner : profileOf(payload.by); // null when the board did it (task.ready)
  const named = who ?? 'someone';
  const maker = profileOf(task.by) ?? (PROFILE_RE.test(profile(msg.by)) ? profile(msg.by) : null);
  const agent = profileOf(task.for) ?? maker;
  const needs = 'needs' in payload ? payload.needs : task.needs;
  const out = [];

  const tell = (target, number, what) => {
    if (!target || target === who || out.some(([t, i]) => t === target && i.thread === number)) return;
    const item = { thread: number, post: null, what, who: who ?? 'board', byPerson: person };
    if (number === tid && CLOSING.includes(kind)) item.closes = true; // its news is this closing: kept although closed
    out.push([target, item]);
  };

  if (gone) {
    const word = kind === 'task.failed' ? 'gave up on (failed)' : 'canceled';
    if (handoff) {
      tell(maker, tid, `\`${named}\` ${word} the task you made; the reason is in the thread`);
      tell(agent, tid, `\`${named}\` ${word} this task of yours; the reason is in the thread`);
    }
    for (const [dep, depAgent] of (dependents ?? []).filter(([d]) => ID_RE.test(String(d))))
      tell(depAgent, String(dep), `waits on #${tid}, which \`${named}\` ${word}: it will not become ready on its own. `
        + `Read #${tid}, then change what it needs (\`tasks needs\`) or cancel it`);
  } else if (kind === 'task.created') {
    const waits = (needs ?? []).filter((n) => ID_RE.test(String(n))).map((n) => `#${n}`).join(', ');
    tell(profileOf(payload.for) ?? agent, tid, `new task for you from \`${named}\``
      + (waits ? `; it waits on ${waits}, and you are pinged when it is ready` : '; ready now'));
  } else if (kind === 'task.assigned') {
    tell(profileOf(payload.for), tid, `\`${named}\` assigned this task to you`);
  } else if (kind === 'task.ready') {
    tell(agent, tid, 'ready: what it waited on is done; the results are in those tasks\' threads'
      + (needs?.length ? ` (${needs.filter((n) => ID_RE.test(String(n))).map((n) => `#${n}`).join(', ')})` : ''));
  } else if (kind === 'task.completed') {
    tell(maker, tid, `\`${named}\` completed the task you made; the result is in the thread`);
  } else if (kind === 'task.reopened') {
    tell(agent, tid, `\`${named}\` reopened this task; it is ready again`);
  }
  return out;
}

/**
 * [(agent, item)] for a post an agent scheduled for itself: that agent is pinged when the board sends it.
 * Session agents only: a tool would be started headless on a timer, unattended spend nobody approved. Mentions
 * in a scheduled post wake nobody, so one agent can't ping another on a repeat.
 */
export function routeSchedule(event, cfg) {
  if (event?.type !== 'message.posted') return [];
  const msg = event.message ?? {};
  const sched = msg.schedule ?? event.payload?.schedule;
  const agent = profile(msg.by);
  if (!sched || typeof sched !== 'object' || !agent || msg.deleted || !ID_RE.test(String(msg.id ?? ''))) return [];
  if (msg.re != null && !ID_RE.test(String(msg.re))) return [];
  const entry = cfg.agents[agent];
  if (!entry || entry.tool) return [];
  return [[agent, { thread: String(msg.re ?? msg.id), post: String(msg.id), what: 'scheduled', kind: 'schedule',
    schedule: SCHEDULE_RE.test(String(sched.id)) ? String(sched.id) : '?', n: Number.isInteger(sched.n) ? sched.n : null }]];
}

/** True when an item's news is that its own task closed: closing it is no reason to drop it. */
export function aboutClosing(item) {
  return Boolean(item.closes || CLOSING.includes(item.event));
}

/** True when a ping must still reach its agent after the task in `thread` closed. */
export function outlivesClose(item, thread) {
  return String(item.thread) !== String(thread) || aboutClosing(item) || item.kind === 'schedule';
}

/** True when the item was caused by a tool (a profile marked tool: true). */
export function causedByTool(item, cfg) {
  return Boolean(item.who && cfg.agents[String(item.who).toLowerCase()]?.tool && !item.byPerson);
}
