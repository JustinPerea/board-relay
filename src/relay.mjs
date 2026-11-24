// The relay: follows the board's event stream and wakes the agent each event is for.
//
// An idle agent takes no turn, so it never sees a reply on its own. For each thing the person does on the board
// (a post, a reply, an edit, a task they unblock, complete or cancel), and for task news between agents in the
// handoff channels, the relay sends one ping to the agent it is meant for. An agent's post wakes the agents it
// @mentions or replies to, within the limits in src/limits.mjs. The ping holds thread numbers and the commands to
// read them, never anyone's words. A ping that can't be delivered waits until it can.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { configStamp, loadConfig, profileOf, isPerson } from './config.mjs';
import { route, routeAgentPost, routeHandoff, routeSchedule, CLOSING, causedByTool } from './route.mjs';
import * as limits from './limits.mjs';
import { pingText, wakePrompt, when } from './ping.mjs';
import * as queue from './queue.mjs';
import { relayBoard, vbEnv, vbScript } from './vb.mjs';
import * as claude from './wake/claude-session.mjs';
import * as command from './wake/command.mjs';
import * as resume from './wake/resume.mjs';
import { procStart } from './wake/resume.mjs';
import * as webhook from './wake/webhook.mjs';

export const RECEIPT = 'bell';
const SERIAL_LIMIT = 15 * 60 * 1000; // the reaction on the person's post once its agent was pinged

const n = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : -1;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export class Relay {
  /**
   * cfg: a normalized config. Everything that touches the outside world can be swapped for tests:
   * board (relayBoard()), adapters ({claude, command, resume, webhook}), clock (() => ms), note (log line).
   */
  constructor(cfg, { configFile = null, board, adapters, clock = Date.now, note, serialLimitMs = SERIAL_LIMIT } = {}) {
    this.serialLimitMs = serialLimitMs;
    this.cfg = cfg;
    this.configFile = configFile;
    this.board = board ?? relayBoard(cfg);
    this.adapters = { claude, command, resume, webhook, ...adapters };
    this.clock = clock;
    this.note = note ?? ((msg) => this.log(msg));
    this.state = queue.emptyState();
    // agent -> {items, first, last}: gathered for their first send. Kept in the saved state (state.held), with the
    // sends under way (state.inflight), so the saved cursor never runs ahead of a ping that hasn't gone out.
    this.held = this.state.held;
    this.chains = new Map(); // agent -> the promise of its last delivery, so one agent's sends never overlap
    this.running = new Map(); // pid -> child, for tool wakes this process started
    this.busy = { tick: false, retry: false, wakes: false };
    this.lastRetry = 0;
    this.saved = '';
  }

  // ------------------------------------------------------------ state and log

  get statePath() { return join(this.cfg.stateDir, 'state.json'); }

  log(msg) {
    try {
      mkdirSync(this.cfg.stateDir, { recursive: true });
      appendFileSync(join(this.cfg.stateDir, 'relay.log'), `${new Date().toISOString()} ${msg}\n`);
    } catch { /* logging must never stop the relay */ }
  }

  load() {
    try {
      this.state = { ...queue.emptyState(), ...JSON.parse(readFileSync(this.statePath, 'utf8')) };
    } catch {
      this.state = queue.emptyState();
    }
    // Sends that were under way when the relay stopped go out again: a ping may arrive twice, never not at all.
    for (const f of this.state.inflight) {
      const h = (this.state.held[f.agent] ??= { items: [], first: 0, last: 0 });
      h.items.push(...f.items);
    }
    this.state.inflight = [];
    this.held = this.state.held;
    return this.state;
  }

  /** Write the state when it changed. */
  save() {
    const text = JSON.stringify(this.state, null, 1);
    if (text === this.saved) return;
    mkdirSync(this.cfg.stateDir, { recursive: true });
    const tmp = this.statePath + '.tmp';
    writeFileSync(tmp, text);
    renameSync(tmp, this.statePath);
    this.saved = text;
  }

  // ------------------------------------------------------------ one event

  /** Route one event into the held pings. Returns the [agent, item] pairs it added. */
  async onEvent(ev) {
    const cfg = this.cfg;
    const msg = ev.message ?? {};
    const byPerson = isPerson(msg.by) || isPerson(ev.payload?.by);
    const author = String(msg.by?.profile ?? '').toLowerCase();
    const byAgent = ev.type === 'message.posted' && cfg.agentPosts.enabled && Boolean(cfg.agents[author]) && !byPerson;
    const thread = (byPerson || byAgent) && msg.id ? (await this.board.readThread(msg.re ?? msg.id)).messages : {};
    // a person's own post or task action, not a reaction or an agent's action on the person's post
    const personActed = ev.type === 'message.posted' || ev.type === 'message.edited' ? isPerson(msg.by)
      : ev.type?.startsWith('task.') && isPerson(ev.payload?.by);
    if (personActed && msg.id) limits.personActed(this.state.agentPosts, msg.re ?? msg.id);
    const [targets, item] = route(ev, thread, cfg);
    const pairs = (targets ?? []).map((a) => [a, item]);
    const notices = [];
    if (byAgent) pairs.push(...this.admitAgentPosts(routeAgentPost(ev, thread, cfg), cfg, notices));
    const gone = ev.type === 'task.failed' || ev.type === 'task.canceled';
    if (gone || (!byPerson && cfg.handoffs.includes(msg.channel)))
      pairs.push(...routeHandoff(ev, gone ? await this.board.waitingOn(msg.id, profileOf) : [], cfg));
    pairs.push(...routeSchedule(ev, cfg));
    if (CLOSING.includes(ev.type) && msg.id) {
      const closed = msg.re ?? msg.id;
      for (const [a, t] of queue.dropClosed(this.state, closed)) this.note(`dropped agent=${a} thread=${t}: its task closed`);
      queue.dropClosedHeld(this.held, closed);
    }
    const now = this.clock();
    for (const [agent, it] of pairs) {
      const h = (this.held[agent] ??= { items: [], first: now, last: 0 });
      h.items.push(it);
      h.last = now;
    }
    for (const [thread, text] of notices) await this.board.reply(thread, text);
    return pairs;
  }

  /** The agent-post pairs the limits let through. Decided without waiting, so the counts and the held pings are
   *  saved together. A limit, a tool's post to a tool, or an agent that takes no such wakes is said once in the
   *  thread (pushed to `notices`), so the agent that posted knows its post woke nobody. */
  admitAgentPosts(pairs, cfg, notices) {
    const st = this.state.agentPosts;
    const now = this.clock();
    const out = [];
    for (const [agent, item] of pairs) {
      const entry = cfg.agents[agent];
      if (!entry) continue;
      const fromTool = entry.tool && causedByTool(item, cfg);
      if (!entry.wakeOnAgentPosts || fromTool) {
        const told = limits.threadOf(st, item.thread, now).told;
        const key = fromTool ? `${agent}:tool` : agent; // the two notices say different things
        if (told.includes(key)) continue;
        told.push(key);
        this.note(`not woken agent=${agent} thread=${item.thread}: ${fromTool ? 'a tool\'s post' : 'it takes no wakes from agents\' posts'}`);
        notices.push([item.thread, fromTool
          ? `Relay: \`${agent}\` was not woken. A tool's post never wakes another tool, so two tools can't start each other in a loop.`
          : entry.tool
            ? `Relay: \`${agent}\` is a tool, and the relay wakes a tool for an agent's post only when its config sets \`wakeOnAgentPosts\` to true. To hand it work, make a task for it in a handoff channel.`
            : `Relay: \`${agent}\` is set not to be woken by agents' posts (\`wakeOnAgentPosts\` is false). To hand it work, make a task for it in a handoff channel.`]);
        continue;
      }
      const r = limits.admit(st, agent, item, cfg.agentPosts, now);
      if (r.ok) { out.push([agent, item]); continue; }
      this.note(`not woken agent=${agent} thread=${item.thread}: the ${r.why === 'hour' ? 'hourly' : 'thread'} limit on agents waking agents`);
      if (!r.notice) continue;
      notices.push([item.thread, r.why === 'hour'
        ? `Relay: agents' posts have woken agents ${cfg.agentPosts.perHour} times in the last hour, the most the relay allows (\`agentPosts.perHour\`), so \`${agent}\` was not woken. Agents' posts wake nobody until the hour's count drops; posts by ${cfg.owner} and tasks still do.`
        : `Relay: agents have woken each other in this thread as often as the relay allows without ${cfg.owner} (\`agentPosts.perThread\` is ${cfg.agentPosts.perThread}), so \`${agent}\` was not woken. Agents' posts here wake nobody until ${cfg.owner} posts in this thread or acts on its task. Tasks still wake agents.`]);
    }
    return out;
  }

  /** Send what has been quiet long enough, or held too long. An agent in its cooldown keeps pings that came only
   *  from agents' posts, even when forced (they are in the saved state); a ping from a person goes out with them. */
  flushHeld(force = false) {
    const now = this.clock();
    const t = this.cfg.timing;
    const sends = [];
    for (const [agent, h] of Object.entries(this.held)) {
      if (!limits.due(this.state.agentPosts, agent, h.items, this.cfg.agentPosts, now)) continue;
      if (force || now - h.last >= t.quietSeconds * 1000 || now - h.first >= t.maxHoldSeconds * 1000) {
        delete this.held[agent];
        limits.sent(this.state.agentPosts, agent, h.items, now);
        const flight = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, agent, items: h.items };
        this.state.inflight.push(flight);
        sends.push(this.serial(agent, () => this.deliver(agent, h.items)).finally(() => {
          this.state.inflight = this.state.inflight.filter((f) => f.id !== flight.id);
        }));
      }
    }
    if (sends.length) this.save();
    return Promise.all(sends);
  }

  /** Run fn after the agent's previous delivery. A step that hangs is given up on after SERIAL_LIMIT, so one stuck
   *  wake can't hold the agent's later pings forever (the adapters stop their own processes well before that). */
  serial(agent, fn) {
    const prev = this.chains.get(agent) ?? Promise.resolve();
    const step = () => {
      let timer;
      const limit = new Promise((resolve) => {
        timer = setTimeout(() => { this.note(`delivery to ${agent} ran past ${Math.round(this.serialLimitMs / 1000)} s; moving on`); resolve(false); }, this.serialLimitMs);
        timer.unref?.();
      });
      return Promise.race([Promise.resolve().then(fn), limit]).finally(() => clearTimeout(timer));
    };
    const next = prev.then(step, step).catch((error) => { this.note(`delivery to ${agent} failed: ${error?.stack ?? error}`); return false; });
    this.chains.set(agent, next);
    return next;
  }

  // ------------------------------------------------------------ delivering

  /** Ping one agent about items. Resolves true when it went out, 'final' when a retry gave up, else false. */
  async deliver(agent, items, firstTry = true) {
    const cfg = this.cfg;
    const sched = items.filter((i) => i.kind === 'schedule');
    if (sched.length && sched.length < items.length) {
      // the agent's own schedule and news from others are kept and told apart
      const a = await this.deliver(agent, items.filter((i) => i.kind !== 'schedule'), firstTry);
      const b = await this.deliver(agent, sched, firstTry);
      return a === true && b === true;
    }
    const quiet = sched.length > 0; // a held scheduled ping says nothing in the thread each time
    const entry = cfg.agents[agent];
    const tool = Boolean(entry?.tool);

    if (tool && entry.wake?.type === 'resume' && entry.wake.enabled && new Set(items.map((i) => i.thread)).size > 1) {
      const sids = {};
      for (const t of new Set(items.map((i) => i.thread)))
        sids[t] = (await resume.recordedSession(agent, [t], cfg, this.board.readThread)).sid ?? null;
      const groups = queue.groupBySession(items, (t) => sids[t]);
      if (groups.length > 1) { // each session is resumed about its own threads
        let all = true;
        for (const g of groups) all = (await this.deliver(agent, g, firstTry)) === true && all;
        return all;
      }
    }

    const r = await this.attempt(agent, items);
    const posts = items.map((i) => i.post).filter(Boolean);
    const threads = [...new Set(items.map((i) => String(i.thread)))];

    // A decision card the person replied to stops reading as waiting on them, whether or not the agent could be
    // woken. The agent clears it by asking again with `ask --replace`.
    for (const t of new Set(items.filter((i) => i.post && i.what === 'reply' && !i.who).map((i) => String(i.thread)))) {
      await this.board.label(t, 'replied=yes', '--if', 'kind=decision');
      if (firstTry) this.state.repliedAt[t] = this.clock();
    }

    if (r.ok) {
      this.note(`delivered agent=${agent} threads=${threads.join(',')}`);
      for (const p of posts) await this.board.react(p, RECEIPT);
      if (!firstTry && !quiet) {
        const back = tool ? 'is free again and has now been woken' : 'is back and has now been pinged';
        for (const t of threads) await this.board.reply(t, `Relay: \`${agent}\` ${back} about this thread.`);
      }
      return true;
    }

    const listed = Boolean(entry);
    if (firstTry && quiet) {
      this.note(`held agent=${agent} threads=${threads.join(',')} (scheduled): ${r.why}`);
      if (listed && r.retry) queue.holdScheduled(this.state, agent, items, this.clock());
      return false;
    }
    if (firstTry) {
      this.note(`undelivered agent=${agent} threads=${threads.join(',')}: ${r.why}${r.detail ? ` [${r.detail.replace(/\s+/g, ' ').slice(-160)}]` : ''}`);
      // the fallback hears about a person's words or task news, not about agents' posts to each other, which the
      // agentPosts limits govern
      const fb = cfg.fallback && cfg.fallback !== agent && items.some((i) => i.kind !== 'agent') ? cfg.fallback : null;
      let tail = '';
      if (r.retry && listed) tail = r.busy ? ' I\'ll try again until it goes through.' : ` I'll hold the ping until \`${agent}\` is back.`;
      if (fb && !r.busy) tail += ` \`${fb}\` has been told.`;
      const verb = tool ? 'woken' : 'pinged';
      for (const t of threads) await this.board.reply(t, `Relay: \`${agent}\` was not ${verb}. ${cap(r.why)}.${tail}`);
      if (r.retry && listed) queue.enqueue(this.state, agent, items, r.why, this.clock());
      if (fb && !r.busy) this.tellFallback(fb, agent, items, r.why, threads);
      return false;
    }
    if (!r.retry) { // a retry found something that won't change by waiting: say so once, stop trying
      this.note(`gave up agent=${agent} threads=${threads.join(',')}: ${r.why}`);
      for (const t of threads) await this.board.reply(t, `Relay: stopped trying to wake \`${agent}\`. ${cap(r.why)}.`);
      return 'final';
    }
    return false;
  }

  /** One try through the agent's wake. {ok} or {ok: false, why, retry, busy, detail}. */
  async attempt(agent, items) {
    const cfg = this.cfg;
    const entry = cfg.agents[agent];
    if (!entry) return { ok: false, why: `\`${agent}\` is not in the relay's config`, retry: false };
    const wake = entry.wake;
    if (!wake) return { ok: false, why: `\`${agent}\` has no wake set up in the relay's config`, retry: false };
    if (!wake.enabled) return { ok: false, why: `\`${agent}\` is not woken by the relay (its wake is turned off)`, retry: false };
    if (entry.tool) {
      items = items.filter((i) => !causedByTool(i, cfg));
      if (!items.length) return { ok: false, why: 'the news came from another tool, and tools don\'t wake each other', retry: false };
    }
    const at = when(new Date(this.clock()));
    const a = this.adapters;
    switch (wake.type) {
      case 'claude-session': {
        const r = await a.claude.deliver(agent, pingText(agent, items, at, cfg), cfg);
        return r.ok ? r : { ...r, retry: true, busy: false };
      }
      case 'command': {
        const r = await a.command.deliver(agent, pingText(agent, items, at, cfg), items, cfg, { configFile: this.configFile });
        return r.ok ? r : { ...r, retry: true, busy: true };
      }
      case 'resume': {
        const threads = [...new Set(items.map((i) => String(i.thread)))];
        const found = await a.resume.recordedSession(agent, threads, cfg, this.board.readThread);
        if (!found.sid) return { ok: false, why: found.why, retry: Boolean(found.transient), busy: Boolean(found.transient) };
        if (this.state.waking.some((w) => w.agent === agent && w.sid === found.sid))
          return { ok: false, why: `\`${agent}\` is still answering an earlier ping in that session`, retry: true, busy: true };
        try {
          const rec = await a.resume.startWake(agent, found.sid, items, wakePrompt(agent, items, at, cfg), cfg,
            { read: this.board.readThread, configFile: this.configFile, running: this.running });
          this.state.waking.push(rec);
          this.note(`woke agent=${agent} pid=${rec.pid} threads=${threads.join(',')}`);
          return { ok: true };
        } catch (error) {
          return { ok: false, why: `\`${agent}\` could not be started (${error.code ?? error.message})`, retry: false };
        }
      }
      case 'webhook': {
        const r = await a.webhook.deliver(agent, items, wakePrompt(agent, items, at, cfg), cfg, this.state, { now: this.clock() });
        return r.ok ? r : { ...r, retry: Boolean(r.transient) };
      }
      default:
        return { ok: false, why: `\`${agent}\` has an unknown wake type`, retry: false };
    }
  }

  /** Tell the fallback agent a ping could not be delivered. Off the main path: it never waits. */
  tellFallback(fb, agent, items, why, threads) {
    const cfg = this.cfg;
    const whose = items.some((i) => !i.who) ? `${cfg.owner} wrote to`
      : items.some((i) => i.kind === 'agent') ? 'Another agent wrote to' : 'There is task news for';
    const text = `[Board relay, automated. Not ${cfg.owner}'s word.]\n${whose} \`${agent}\` on the board and the ping was not `
      + `delivered: ${why}.\nThreads: ${threads.map((t) => '#' + t).join(', ')}\n`
      + `Read: ${cfg.agentCommand} --as ${fb} read ${threads[0]}`;
    const wake = cfg.agents[fb]?.wake;
    if (!wake?.enabled) return;
    const go = wake.type === 'claude-session' ? this.adapters.claude.deliver(fb, text, cfg)
      : wake.type === 'command' ? this.adapters.command.deliver(fb, text, items, cfg, { configFile: this.configFile, reason: 'notice' })
        : null;
    go?.catch((error) => this.note(`could not tell ${fb}: ${error}`));
  }

  /** Try again what waits. A session agent's waiting pings go out together once it is back; a tool's or a
   *  command's are retried one by one with a growing gap. */
  async retryPending() {
    const cfg = this.cfg;
    const t = cfg.timing;
    const now = this.clock();
    limits.prune(this.state.agentPosts, cfg.agentPosts, now);
    for (const a of queue.pruneGone(this.state, cfg.agents, now, t.goneGraceSeconds)) this.note(`dropped what waited for ${a}: not in the config any more`);
    const done = new Set();
    for (const p of [...this.state.pending]) {
      const entry = cfg.agents[p.agent];
      if (!entry) continue;
      if (entry.wake?.type === 'claude-session') {
        if (done.has(p.agent)) continue;
        done.add(p.agent);
        const mine = this.state.pending.filter((q) => q.agent === p.agent);
        if (!mine.some((q) => now >= queue.nextTry(q, t.retrySeconds))) continue;
        for (const q of mine) q.tried = now;
        // its wake turned off (or a type that's no longer a session): stop, the way a tool's final failure does
        if (!entry.wake.enabled) {
          await this.serial(p.agent, () => this.deliver(p.agent, mine.flatMap((q) => q.items), false));
          for (const q of mine) q.items = [];
          continue;
        }
        if (!this.adapters.claude.reachable(p.agent, cfg)) continue;
        for (const sched of [false, true]) {
          const part = mine.flatMap((q) => q.items.filter((i) => (i.kind === 'schedule') === sched));
          if (!part.length) continue;
          const r = await this.serial(p.agent, () => this.deliver(p.agent, part, false));
          if (r === 'final') { for (const q of mine) q.items = []; break; }
          if (r !== true) { for (const q of mine) queue.backOff(q, now, t.retrySeconds, t.backoffMaxSeconds); break; }
          for (const q of mine) q.items = q.items.filter((i) => (i.kind === 'schedule') !== sched);
        }
        continue;
      }
      if (now < queue.nextTry(p, t.retrySeconds)) continue;
      p.tried = now;
      const r = await this.serial(p.agent, () => this.deliver(p.agent, p.items, false));
      if (r === true || r === 'final') p.items = [];
      else queue.backOff(p, now, t.retrySeconds, t.backoffMaxSeconds);
    }
    this.state.pending = this.state.pending.filter((p) => p.items.length);
  }

  async checkWakes() {
    if (!this.state.waking.length) return false;
    return resume.checkWakes(this.state, this.cfg, {
      read: this.board.readThread, reply: this.board.reply, running: this.running, now: this.clock(), note: this.note,
    });
  }

  // ------------------------------------------------------------ running

  lock() {
    mkdirSync(this.cfg.stateDir, { recursive: true });
    const path = join(this.cfg.stateDir, 'lock');
    for (let i = 0; i < 2; i++) {
      try {
        // the pid and its start time: after a reboot the same pid can belong to another program
        const mine = JSON.stringify({ pid: process.pid, start: procStart(process.pid) });
        const fd = openSync(path, 'wx');
        writeFileSync(fd, mine);
        closeSync(fd);
        return () => { try { if (readFileSync(path, 'utf8') === mine) rmSync(path); } catch { /* gone */ } };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let rec = {};
        try { rec = JSON.parse(readFileSync(path, 'utf8')); } catch { rec = { pid: n(readFileSync(path, 'utf8')) }; }
        const pid = n(rec.pid);
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
        if (alive && pid > 0 && (!rec.start || procStart(pid) === rec.start))
          throw new Error(`the relay is already running (pid ${pid}); two would each ping every agent`);
        rmSync(path, { force: true });
      }
    }
    throw new Error('could not take the relay lock');
  }

  /** Follow the board until stopped. Reconnects when the stream ends (the board restarted). */
  async run({ signal } = {}) {
    const unlock = this.lock();
    this.load();
    this.note(`started${this.state.waking.length ? `; following ${this.state.waking.length} tool wake(s) started before` : ''}`);
    resume.pruneWakeLogs(this.cfg, this.clock());
    let stamp = this.configFile ? configStamp(this.configFile) : null;
    try {
      while (!signal?.aborted) {
        await this.follow(signal, () => {
          if (!this.configFile) return;
          const s = configStamp(this.configFile);
          if (s === stamp) return;
          stamp = s;
          try {
            this.cfg = loadConfig(this.configFile);
            this.note(`config changed: ${Object.keys(this.cfg.agents).length} agents`);
          } catch (error) {
            this.note(`config changed but could not be read (${error.message}); keeping the one from before`);
          }
        });
        if (signal?.aborted) break;
        this.note('the event stream ended; reconnecting in 3 s');
        await new Promise((r) => setTimeout(r, 3000));
      }
    } finally {
      await this.flushHeld(true);
      await Promise.all(this.chains.values());
      this.save();
      unlock();
    }
  }

  /** Once a second: send what is ready, save, and start a retry pass or a wake check when one is due. Retries and
   *  wake checks run on their own, so a slow one never holds up first sends or saving. */
  tick(reload) {
    if (this.busy.tick) return;
    this.busy.tick = true;
    try {
      reload?.();
      this.flushHeld();
      this.save();
      const now = this.clock();
      if (this.state.pending.length && !this.busy.retry && now - this.lastRetry >= 30000) {
        this.lastRetry = now;
        this.busy.retry = true;
        this.retryPending().catch((error) => this.note(`retry failed: ${error}`))
          .finally(() => { this.busy.retry = false; this.save(); });
      }
      if (this.state.waking.length && !this.busy.wakes) {
        this.busy.wakes = true;
        this.checkWakes().catch((error) => this.note(`wake check failed: ${error}`))
          .finally(() => { this.busy.wakes = false; this.save(); });
      }
    } catch (error) {
      this.note(`tick failed: ${error?.stack ?? error}`);
    } finally {
      this.busy.tick = false;
    }
  }

  follow(signal, reload) {
    const args = [vbScript(), 'tail', '--json', '--url', this.cfg.board, '--as', this.cfg.relay];
    if (this.state.cursor != null) args.push('--after', String(this.state.cursor));
    const child = spawn(process.execPath, args, { env: vbEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    let chain = Promise.resolve();
    let seen = n(this.state.cursor);
    const timer = setInterval(() => this.tick(reload), 1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (buf + chunk).split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const cur = n(ev.cursor);
        if (cur <= seen) continue;
        seen = cur;
        // The cursor moves only once the event's pings are in `held`, which is saved with it.
        chain = chain.then(() => this.onEvent(ev)).catch((error) => this.note(`event ${cur} failed: ${error?.stack ?? error}`))
          .then(() => { if (cur > n(this.state.cursor)) this.state.cursor = String(cur); });
      }
    });
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    return new Promise((resolve) => {
      child.on('close', async () => {
        clearInterval(timer);
        signal?.removeEventListener('abort', stop);
        await chain;
        this.tick(reload);
        resolve();
      });
    });
  }
}
