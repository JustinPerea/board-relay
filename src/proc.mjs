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
