import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Stopping a child process for good: SIGTERM to its group, then SIGKILL if it is still there after a grace period.
// Callers resolve on their own timer, so a child that ignores both can't hold them.
export const GRACE_MS = 5000;

export function stopGroup(child, grace = GRACE_MS) {
  const sig = (s) => {
    try { process.kill(-child.pid, s); } catch { try { child.kill(s); } catch { /* gone */ } }
  };
  sig('SIGTERM');
  const t = setTimeout(() => sig('SIGKILL'), grace);
  t.unref?.();
}

// ps and lsof by absolute path with a fixed PATH, so a program can't answer for them by putting its own `ps` first.
const firstOf = (paths) => paths.find((p) => existsSync(p)) ?? null;
const PS = firstOf(['/bin/ps', '/usr/bin/ps']);
const LSOF = firstOf(['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof']);
const TOOL_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' };

function call(run, bin, args, timeout) {
  if (!bin) return '';
  try { return String(run(bin, args, { encoding: 'utf8', timeout, env: TOOL_ENV })?.stdout ?? ''); } catch { return ''; }
}

/** One process from `lsof -p <pid> -FRfn`: its parent pid, its executable (the first `txt` entry) and the paths it
 *  holds open. lsof answers inside some sandboxes that refuse `ps` (Devin's, measured with devin 3000.14). */
export function lsofInfo(pid, run = spawnSync, bin = LSOF) {
  let ppid = null;
  let exe = null;
  let fd = null;
  const files = [];
  for (const line of call(run, bin, ['-p', String(pid), '-FRfn'], 5000).split('\n')) {
    const k = line[0];
    const v = line.slice(1);
    if (k === 'R') ppid = v;
    else if (k === 'f') fd = v;
    else if (k === 'n') {
      files.push(v);
      if (fd === 'txt' && exe === null) exe = v;
    }
  }
  return { ppid, exe, files };
}

/**
 * [[pid, command path]] from this process up to (not including) pid 1. Each step asks `ps`, and `lsof` where ps
 * is refused. The array's `complete` is true only when the walk reached pid 1 (or 0): a walk that stopped partway
 * may have missed an ancestor, so a pin check must not treat it as "no pinned parent".
 */
export function ancestors(limit = 64, start = process.pid, run = spawnSync, bins = { ps: PS, lsof: LSOF }) {
  const out = [];
  out.complete = false;
  let pid = String(start);
  for (let i = 0; i < limit; i++) {
    let ppid = null;
    let comm = null;
    const m = /^(\d+)\s+(.*)$/.exec(call(run, bins.ps, ['-o', 'ppid=,comm=', '-p', pid], 3000).trim());
    if (m) [, ppid, comm] = m;
    else {
      const info = lsofInfo(pid, run, bins.lsof);
      if (info.ppid) [ppid, comm] = [info.ppid, info.exe ?? ''];
    }
    if (!ppid) break;
    out.push([pid, comm]);
    if (ppid === '0' || ppid === '1') {
      out.complete = true;
      break;
    }
    pid = ppid;
  }
  return out;
}

/** Paths a process holds open. Empty when lsof is missing or refuses. */
export function openFiles(pid, run = spawnSync) {
  return lsofInfo(pid, run).files;
}
