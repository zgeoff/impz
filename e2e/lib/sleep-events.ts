import * as z from 'zod';
import { ENFORCE_TRIGGER } from '../../packages/daemon/src/vm/governor/ram-governor';
import type { SleepSpan } from './budget-overshoot';
import { startImp } from './imp-cli';

const SleptEventSchema = z.object({
  ev: z.literal('ImpChanged'),
  reason: z.literal('slept'),
  at: z.iso.datetime(),
  detail: z.object({
    durationMs: z.int().nonnegative(),
    prepareMs: z.int().nonnegative().optional(),
    trigger: z.string().optional(),
  }),
});

export function parseSleepSpan(line: string): SleepSpan | null {
  const event = SleptEventSchema.safeParse(JSON.parse(line));

  if (!event.success) {
    return null;
  }

  const endAt = Date.parse(event.data.at);

  // An impd older than the prepareMs field sends none, so its start reads late.
  const prepareMs = event.data.detail.prepareMs ?? 0;

  return {
    startAt: endAt - event.data.detail.durationMs - prepareMs,
    endAt,
    isEnforce: event.data.detail.trigger === ENFORCE_TRIGGER,
  };
}

export interface SleepWatch {
  readonly sleeps: readonly SleepSpan[];
  readonly stop: () => Promise<void>;
}

export async function startSleepWatch(): Promise<SleepWatch> {
  const events = await startImp(['events']);

  const sleeps: SleepSpan[] = [];

  const reading = (async () => {
    const decoder = new TextDecoder();

    let buffered = '';

    for await (const chunk of events.stdout) {
      buffered += decoder.decode(chunk, { stream: true });

      const lines = buffered.split('\n');

      buffered = lines.pop() ?? '';

      for (const line of lines) {
        const sleep = parseSleepSpan(line);

        if (sleep !== null) {
          sleeps.push(sleep);
        }
      }
    }
  })();

  return {
    sleeps,
    stop: async () => {
      events.kill();

      await reading;
    },
  };
}
