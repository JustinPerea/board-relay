// What waits to reach an agent. A ping that could not be delivered is kept until it is: it is dropped only when
// the task in its thread closes, or when its agent has been out of the config for a while. Age is never a reason.
// Pure functions over the relay's saved state.
import { outlivesClose } from './route.mjs';

export function emptyState() {
  return { cursor: null, held: {}, inflight: [], pending: [], waking: [], webhookLast: {}, goneSince: {}, repliedAt: {},
    agentPosts: { threads: {}, recent: [], woke: {}, hourNotice: null } };
}

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Add a ping to the waiting list. */
export function enqueue(state, agent, items, why, now) {
  state.pending.push({ agent, items, since: now, tried: now, why: String(why) });
}

/** Keep a scheduled ping until its agent is back. A repeat whose agent is away keeps one waiting ping per
 *  schedule (the latest send), so an hourly check-in for an agent gone a week is one entry, not 168. */
export function holdScheduled(state, agent, items, now) {
  const ids = new Set(items.map((it) => it.schedule));
  state.pending = state.pending.filter((p) => {
    if (p.agent !== agent) return true;
    p.items = p.items.filter((i) => !(i.kind === 'schedule' && ids.has(i.schedule)));
    return p.items.length > 0;
  });
  enqueue(state, agent, items, 'no live session when it was sent', now);
}

/** A task closed: what waits about that thread no longer has to reach anyone, unless its news is the closing
 *  itself or it is the agent's own scheduled post. Returns the dropped [agent, thread] pairs for the log. */
export function dropClosed(state, thread) {
  const dropped = [];
  state.pending = state.pending.filter((p) => {
    const keep = p.items.filter((i) => outlivesClose(i, thread));
    if (keep.length < p.items.length) dropped.push([p.agent, String(thread)]);
    p.items = keep;
    return keep.length > 0;
  });
  return dropped;
}

/** dropClosed() for pings still being gathered for their first send ({agent: {items, first, last}}). */
export function dropClosedHeld(held, thread) {
  for (const agent of Object.keys(held)) {
    held[agent].items = held[agent].items.filter((i) => outlivesClose(i, thread));
    if (!held[agent].items.length) delete held[agent];
  }
}

/** Drop what waits for an agent that has been out of the config for goneGraceSeconds. */
export function pruneGone(state, agents, now, graceSeconds) {
  const gone = state.goneSince;
  for (const a of Object.keys(gone)) if (agents[a]) delete gone[a];
  const dropped = [];
  state.pending = state.pending.filter((p) => {
    if (agents[p.agent]) return true;
    gone[p.agent] ??= now;
    if (now - gone[p.agent] >= graceSeconds * 1000) {
      dropped.push(p.agent);
      return false;
    }
    return true;
  });
  for (const a of Object.keys(gone)) if (!state.pending.some((p) => p.agent === a)) delete gone[a];
  return dropped;
}

/** When a waiting entry is tried next: its backed-off time, or retrySeconds after its last try. */
export function nextTry(p, retrySeconds) {
  return num(p.next) ?? (num(p.tried) ?? 0) + retrySeconds * 1000;
}

/** After a failed retry of a tool wake: double the gap, up to the cap. */
export function backOff(p, now, retrySeconds, maxSeconds) {
  const wait = num(p.wait) ?? retrySeconds * 1000;
  p.wait = Math.min(wait * 2, maxSeconds * 1000);
  p.next = now + p.wait;
}

/** [[items]] with one list per tool session, so two threads answered together resume each its own session.
 *  find(thread) -> session id or null. A thread with no session stays on its own. */
export function groupBySession(items, find) {
  const groups = new Map();
  for (const it of items) {
    const sid = find(it.thread);
    const key = sid ? `s:${sid}` : `t:${it.thread}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.values()];
}

/** One line per agent with pings waiting for it, oldest first. */
export function waitingLines(state, now, retrySeconds) {
  const by = new Map();
  for (const p of state.pending) {
    if (!by.has(p.agent)) by.set(p.agent, []);
    by.get(p.agent).push(p);
  }
  const oldest = (ps) => Math.min(...ps.map((p) => p.since));
  return [...by.entries()].sort((a, b) => oldest(a[1]) - oldest(b[1])).map(([agent, ps]) => {
    const threads = [...new Set(ps.flatMap((p) => p.items.map((i) => String(i.thread))))];
    const mins = (now - oldest(ps)) / 60000;
    const age = mins >= 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins)} min`;
    const count = ps.reduce((n, p) => n + p.items.length, 0);
    const backed = ps.some((p) => num(p.next));
    const next = backed ? Math.min(...ps.map((p) => nextTry(p, retrySeconds))) : 0;
    return `${agent}: ${count} waiting, oldest ${age}, threads ${threads.map((t) => '#' + t).join(', ')} (${ps.at(-1).why})`
      + (next ? `; next try ${new Date(next).toTimeString().slice(0, 5)}` : '');
  });
}
