// Wake a cloud agent by calling its webhook. The body carries thread and post numbers and the usual ping, never
// anyone's words, so the agent reads the board itself.
//
// Headers (an Authorization line, say) live in a JSON file of your own, mode 600, never in board-relay.json, and
// are never logged or posted. The relay refuses a headers file others can read, a URL that isn't https, and a
// redirect (it never follows one, so a key is never sent on). 429, 5xx and no answer are retried; any other refusal
// is final. One call per agent per cooldown: a webhook agent usually reads every ready task each time it runs.
import { readFileSync, statSync } from 'node:fs';

export function webhookHeaders(agent, wake, uid = process.getuid?.()) {
  if (!wake.headersFile) return { headers: {} };
  let st;
  try { st = statSync(wake.headersFile); } catch { return { why: `\`${agent}\` has no headers file yet` }; }
  if ((st.mode & 0o077) !== 0 || (uid != null && st.uid !== uid)) return { why: `\`${agent}\`'s headers file must be mode 600 and yours` };
  let h;
  try { h = JSON.parse(readFileSync(wake.headersFile, 'utf8')); } catch { return { why: `\`${agent}\`'s headers file is not JSON` }; }
  if (!h || typeof h !== 'object' || Array.isArray(h) || !Object.entries(h).every(([k, v]) => typeof k === 'string' && typeof v === 'string'))
    return { why: `\`${agent}\`'s headers file must be an object of text values` };
  return { headers: h };
}

/** {ok} or {ok: false, why, busy, transient}. busy/transient: try again later. */
export async function deliver(agent, items, prompt, cfg, state, { now = Date.now(), fetchImpl = fetch } = {}) {
  const wake = cfg.agents[agent].wake;
  const url = new URL(wake.url);
  if (url.protocol !== 'https:' && !(cfg.allowLocalWebhook && url.hostname === '127.0.0.1'))
    return { ok: false, why: `\`${agent}\`'s webhook url is not https` };
  const { headers, why } = webhookHeaders(agent, wake);
  if (why) return { ok: false, why };
  const cooldown = (wake.cooldownSeconds ?? 120) * 1000;
  const since = now - (state.webhookLast[agent] ?? 0);
  if (since < cooldown) return { ok: false, why: `\`${agent}\`'s webhook was called ${Math.round(since / 1000)} s ago`, busy: true, transient: true };
  const body = JSON.stringify({ source: 'board-relay', agent, threads: [...new Set(items.map((i) => i.thread))],
    posts: items.map((i) => i.post).filter(Boolean), prompt });
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'user-agent': 'board-relay', ...headers } });
  } catch (error) {
    return { ok: false, why: `\`${agent}\`'s webhook did not answer (${error.name})`, busy: true, transient: true };
  }
  const code = res.status;
  if (code >= 200 && code < 300) {
    state.webhookLast[agent] = now;
    return { ok: true };
  }
  if (code === 429 || code >= 500) return { ok: false, why: `\`${agent}\`'s webhook answered ${code}`, busy: true, transient: true };
  if ((code >= 300 && code < 400) || res.type === 'opaqueredirect')
    return { ok: false, why: `\`${agent}\`'s webhook answered with a redirect, which the relay doesn't follow` };
  return { ok: false, why: `\`${agent}\`'s webhook refused the call (${code})` };
}
