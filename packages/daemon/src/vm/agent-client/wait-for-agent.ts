import type { Ping } from '@impz/agent-protocol';
import type { Clock } from '../../platform/process/clock';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { REAL_CLOCK } from '../../platform/process/real-clock';
import { sendPing } from './agent-requests';

export interface WaitOptions {
  readonly deadlineMs: number;
  readonly firstDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly attemptMs?: number;
  readonly isParked?: boolean;
  readonly clock?: Pick<Clock, 'now' | 'sleep'>;
}

// During boot Firecracker's vsock socket may not exist yet, refuse the CONNECT, or close, so every
// failure retries until the deadline.
export async function waitForAgent(
  vsockPath: string,
  options: Readonly<WaitOptions>,
): Promise<Ping> {
  const clock = options.clock ?? REAL_CLOCK;
  const deadline = clock.now() + options.deadlineMs;
  const maxDelay = options.maxDelayMs ?? 100;
  let delay = options.firstDelayMs ?? 5;
  let lastError: unknown = null;

  while (clock.now() < deadline) {
    const attemptMs = Math.min(options.attemptMs ?? 1000, deadline - clock.now());

    try {
      const ping = await sendPing(vsockPath, Math.max(1, attemptMs));

      const isParked = ping.stage === 'template';

      if (options.isParked === undefined || options.isParked === isParked) {
        return ping;
      }

      const waitedFor = isParked ? 'still parked in the template' : 'not parked';

      lastError = new Error(waitedFor);
    } catch (error) {
      lastError = error;
    }

    await clock.sleep(delay);

    delay = Math.min(maxDelay, delay * 2);
  }

  const reason = getErrorMessage(lastError);

  throw new Error(
    `agent did not answer within ${String(options.deadlineMs)} ms (last error: ${reason})`,
  );
}
