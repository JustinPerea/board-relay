// Limits on agents waking each other with posts (cfg.agentPosts), so two agents can't keep each other busy, or
// spend, without end. Pure: the relay keeps the state in its saved state (state.agentPosts) and passes the clock.
//
// - Per thread: each wake an agent's post causes counts 1, and 2 when it answers the agent that just woke it
//   (A wakes B, then B wakes A, with no person in between). Past perThread the thread is capped: agents' posts there
//   wake nobody until a person posts or acts on a task in it.
// - Per board: at most perHour such wakes in any hour.
// - Per agent: an agent woken by an agent's post is not woken that way again within cooldownSeconds; what arrives
//   meanwhile is held and goes out as one ping (see due()).

const HOUR = 3600 * 1000;
const FORGET = 7 * 24 * HOUR; // a thread with no agent posts for a week starts over

export function emptyLimits() {
  return { threads: {}, recent: [], woke: {} };
}

/** The record of agents' wakes in one thread, made on first use. */
export function threadOf(st, thread, now) {
  const th = (st.threads[String(thread)] ??= { count: 0, last: null, capped: false, hourNotice: null, told: [], at: now });
  th.at = now;
  return th;
}

/** A person posted or acted on a task in this thread: agents may wake each other there again. */
export function personActed(st, thread) {
  delete st.threads[String(thread)];
}

/**
 * Whether an agent's post may wake `agent` about `item` ({thread, who}). On yes the wake is counted.
 * Returns {ok: true}, or {ok: false, why: 'thread' | 'hour', notice} where notice is true the first time a limit
 * stops a wake in that thread (once per cap, and once an hour for the board-wide limit), so the relay says so once.
 */
export function admit(st, agent, item, limits, now) {
  st.recent = st.recent.filter((t) => now - t < HOUR);
  const th = threadOf(st, item.thread, now);
  if (th.capped) return { ok: false, why: 'thread', notice: false };
  if (st.recent.length >= limits.perHour) {
    const notice = th.hourNotice == null || now - th.hourNotice >= HOUR;
    if (notice) th.hourNotice = now;
    return { ok: false, why: 'hour', notice };
  }
  const answering = Boolean(th.last && th.last[0] === agent && th.last[1] === item.who);
  const cost = answering ? 2 : 1;
  if (th.count + cost > limits.perThread) {
    th.capped = true;
    return { ok: false, why: 'thread', notice: true };
  }
  th.count += cost;
  th.last = [item.who, agent];
  st.recent.push(now);
  return { ok: true };
}

/** False while `agent` is in its cooldown and every item held for it came from an agent's post. */
export function due(st, agent, items, limits, now) {
  if (!items.length || !items.every((i) => i.kind === 'agent')) return true;
  const last = st.woke[agent];
  return !(last != null && now - last < limits.cooldownSeconds * 1000);
}

/** Start `agent`'s cooldown when a ping with agent-post items goes out. */
export function sent(st, agent, items, now) {
  if (items.some((i) => i.kind === 'agent')) st.woke[agent] = now;
}

/** Forget what no longer matters: old threads, ended cooldowns, the hour's count. */
export function prune(st, limits, now) {
  st.recent = st.recent.filter((t) => now - t < HOUR);
  for (const [k, th] of Object.entries(st.threads)) if (now - th.at >= FORGET) delete st.threads[k];
  for (const [a, t] of Object.entries(st.woke)) if (now - t >= limits.cooldownSeconds * 1000) delete st.woke[a];
}
