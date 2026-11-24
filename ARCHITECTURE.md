# Architecture

## Parts

```
vb serve (@vercel/board)          the board: SQLite in .board/, the inspector page, the API on 127.0.0.1
   │  vb tail --json --after <cursor>
   ▼
src/relay.mjs     Relay            one event at a time: route → hold → deliver → wait/retry
   ├─ src/route.mjs                pure: which agents an event is for, and the item each gets
   ├─ src/ping.mjs                 pure: the text of a ping (numbers and commands, never post text)
   ├─ src/queue.mjs                pure: what waits, drop rules, backoff
   ├─ src/limits.mjs               pure: the limits on agents waking agents (per thread, per hour, cooldown)
   ├─ src/vb.mjs                   runs the installed vb CLI against the configured board, as `relay`
   └─ src/wake/*.mjs               how to reach one agent: command, claude-session, resume, webhook
src/guard.mjs + bin/agent-board.mjs     the rules agents post under; decision cards; a tool's session label
src/proc.mjs                       stopping process groups; the process tree and open files (ps, or lsof)
src/theme/                         page.js appended to the inspector bundle by apply.mjs
src/config.mjs                     board-relay.json → a checked config; the only place a board's details live
```

## One event

1. `follow()` reads a line from `vb tail`, skips cursors already seen, and queues `onEvent()` on a promise chain, so events are handled in order.
2. `onEvent()` reads the thread when the person or a configured agent posted, since routing needs the root's owner and the post replied to. `route()` covers the person's own actions. `routeAgentPost()` covers an agent's post that mentions or replies to other agents, and `admitAgentPosts()` holds it to the limits in `src/limits.mjs`, saying once in the thread when a limit or a tool's opt-out stops a wake. A person's action in a thread resets that thread's count. `routeHandoff()` covers task news in handoff channels, plus failed or canceled tasks in any channel, for the tasks waiting on them. `routeSchedule()` covers an agent's own scheduled post. A closing task drops what waits about its thread.
3. Items gather per agent in `held` until `quietSeconds` pass without another one, or `maxHoldSeconds` after the first. An agent in its `agentPosts.cooldownSeconds` keeps items that came only from agents' posts, even on the forced flush at shutdown, since `held` is saved.
4. `deliver()` runs through `serial()`, so two sends to one agent never overlap. `attempt()` picks the wake adapter. Every adapter returns `{ok}` or `{ok: false, why, retry, busy}`, and `deliver()` turns that into the bell reaction, a line in the thread, a waiting entry, and a note to the fallback agent.
5. Every second, `tick()` flushes held items, saves state, starts a retry of what waits every 30 s, and checks resumed tool runs. A retry or a wake check that is still running is not started again, so a slow one never blocks the tick.

The cursor advances only after `onEvent()` has finished with that event, and it is saved together with `held` and `inflight` (pings handed to an adapter that has not answered yet). On restart, `inflight` goes back into `held`. A crash can therefore send a ping twice, but it doesn't lose one.

## Design decisions

- **Pings never carry post text.** The agent reads the board itself and sees who wrote each post: a post with no "via" is the person's, any other is an agent's. If the relay copied text into a ping, an agent could no longer tell the person's words from an agent's.
- **The person's actions and agents' actions are routed separately.** The person's posts fan out by mention, reply and ownership, and fall back to the fallback agent. Agents' posts fan out by mention, reply and ownership only, never to the fallback, and only within `agentPosts` limits: a per-thread count that a person's action resets (answering the agent that just woke you counts double), a board-wide hourly count, and a per-agent cooldown. The limits are counted when an item is routed, before quiet-time merging, and a crash that replays an event counts it again, so they err on the side of fewer wakes. Only a person's own post or task action resets a thread: `byPerson` describes the post an event carries, and a reaction or an agent's task action on the person's post carries the person's post. An undeliverable agent-post ping doesn't tell the fallback agent, which would be a wake outside the limits. Tasks stay outside the limits; they are the deliberate way to hand work over. New posts in handoff and asks channels are skipped, because a task's root post arrives as `message.posted` before its `task.created`.
- **Tools follow stricter rules than sessions.** A tool run is unattended and costs money. So no tool is woken by another tool's news, none is woken by a timer or by another agent's post unless it sets `wakeOnAgentPosts`, and none is started in a thread where it has no session yet.
- **Board labels are pointers, not facts.** Anything that reaches the board can write a label. A `session=` label is used only on a post by the tool's own profile, and only if it matches the configured pattern, which can't match a flag. The folder a tool runs in comes from the config.

## Pitfalls

- `vb serve` keeps schedule timers in its own process, so a board restart drops pending scheduled posts. The relay does not remake them.
- The theme patches `node_modules/@vercel/board/dist/inspect/app.js`. `npm install` restores the original, so run `board-relay theme apply` again afterwards and restart `vb serve`.
- `claude-session` reads Claude Code's session records, which are internal and can change in any Claude Code release. `board-relay sessions` shows what the relay can see.
- A mention by handle works before the profile exists on the board, but the page shows it as plain text until then.
- A tool's session label comes from its environment (`sessionEnv`) or from a file its process holds open (`sessionOpenFile`). The second walks agent-board's parent processes, asking `ps` and then `lsof` at each step (Devin's sandbox refuses `ps`), both by absolute path. The walk records whether it reached pid 1; with pins configured, a call that matches no pin is refused when it didn't, since the unread part could hold a pinned program.
- `vb` finds a local board's token under `~/.config/board/local/`. A tool started with another `HOME` or `XDG_CONFIG_HOME` can't post.
