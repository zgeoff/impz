import type { StartTimer } from '../hosts/fan-out';

interface StubTimeout {
  readonly durationMs: number;
  state: 'pending' | 'fired' | 'cancelled';
}

export function buildStubTimeouts() {
  const timers: StubTimeout[] = [];

  const fires = new Map<StubTimeout, () => void>();

  const startTimer: StartTimer = (durationMs, fire) => {
    const timer: StubTimeout = { durationMs, state: 'pending' };

    timers.push(timer);
    fires.set(timer, fire);

    return () => {
      if (timer.state === 'pending') {
        timer.state = 'cancelled';
      }
    };
  };

  return {
    startTimer,
    timers,
    firePending: (): void => {
      for (const timer of timers.filter((pending) => pending.state === 'pending')) {
        timer.state = 'fired';
        fires.get(timer)?.();
      }
    },
  };
}
