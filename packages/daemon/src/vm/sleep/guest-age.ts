const POLL_MS = 50;

interface GuestAgeWait {
  readonly readUptimeMs: () => Promise<number | null>;
  readonly minUptimeMs: number;
  readonly isWanted: () => Promise<boolean>;
  readonly now?: () => number;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

// Before Linux 6.7, KVM restores a TSC under one second old as about 0, and the guest clock stalls
// until it catches up.
export async function waitForGuestAge(wait: Readonly<GuestAgeWait>): Promise<number | null> {
  if (wait.minUptimeMs === 0) {
    return 0;
  }

  const uptimeMs = await wait.readUptimeMs();

  if (uptimeMs === null || uptimeMs >= wait.minUptimeMs) {
    return 0;
  }

  const now = wait.now ?? (() => performance.now());
  const sleep = wait.sleep ?? Bun.sleep;
  const started = now();
  const deadline = started + wait.minUptimeMs - uptimeMs;

  for (let at = started; at < deadline; at = now()) {
    if (!(await wait.isWanted())) {
      return null;
    }

    await sleep(Math.min(POLL_MS, deadline - at));
  }

  const wanted = await wait.isWanted();

  return wanted ? Math.round(now() - started) : null;
}
