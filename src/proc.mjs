import { spawnSync } from 'node:child_process';

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

/** One process from `lsof -p <pid> -FRfn`: its parent pid, its executable (the first `txt` entry) and the paths it
 *  holds open. lsof answers inside some sandboxes that refuse `ps` (Devin's, measured with devin 3000.14). */
export function lsofInfo(pid, run = spawnSync) {
  let r;
  try { r = run('lsof', ['-p', String(pid), '-FRfn'], { encoding: 'utf8', timeout: 5000 }); } catch { r = null; }
  let ppid = null;
  let exe = null;
  let fd = null;
  const files = [];
  for (const line of String(r?.stdout ?? '').split('\n')) {
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

/** [[pid, command path]] from this process up to (not including) pid 1. Uses `ps`, or lsof where ps is refused.
 *  Empty when neither can read the process table. */
export function ancestors(limit = 16, start = process.pid, run = spawnSync) {
  const out = [];
  let pid = String(start);
  for (let i = 0; i < limit; i++) {
    let r;
    try { r = run('ps', ['-o', 'ppid=,comm=', '-p', pid], { encoding: 'utf8', timeout: 3000 }); } catch { r = null; }
    const m = /^(\d+)\s+(.*)$/.exec(String(r?.stdout ?? '').trim());
    if (!m) break;
    out.push([pid, m[2]]);
    if (m[1] === '0' || m[1] === '1') return out;
    pid = m[1];
  }
  if (out.length) return out;
  pid = String(start);
  for (let i = 0; i < limit; i++) {
    const { ppid, exe } = lsofInfo(pid, run);
    if (!ppid) break;
    out.push([pid, exe ?? '']);
    if (ppid === '0' || ppid === '1') break;
    pid = ppid;
  }
  return out;
}

/** Paths a process holds open. Empty when lsof is missing or refuses. */
export function openFiles(pid, run = spawnSync) {
  return lsofInfo(pid, run).files;
}
