import type { Imp, ImpEvent } from '@impz/api';
import { EVENT_VERSION, isImpAllowed } from '@impz/api';
import { createLogouts } from '@impz/daemon/src/identity/auth/logouts';
import type { EventBus } from '@impz/daemon/src/platform/events/event-bus';
import { openEventStream } from '@impz/daemon/src/platform/events/event-stream';

type ImpdEventListener = (event: Readonly<ImpEvent>) => void;

interface StreamSession {
  readonly imps: readonly string[] | null;
  readonly expiresAt: Date;
}

interface StreamClock {
  readonly now?: () => number;
  readonly startTimer?: (fire: () => void, durationMs: number) => () => void;
}

export const impdEventListeners = new Set<ImpdEventListener>();

const impdEventBus: EventBus = {
  publish: (event) => {
    for (const listener of impdEventListeners) {
      listener(event);
    }
  },
  subscribe: (listener) => {
    impdEventListeners.add(listener);

    return () => {
      impdEventListeners.delete(listener);
    };
  },
};

export const impdLogouts = createLogouts();

export function emitImpdEvent(event: ImpEvent): void {
  impdEventBus.publish(event);
}

export function openImpdEventStream(
  session: StreamSession,
  readImps: () => readonly Imp[],
  signal: AbortSignal | undefined,
  clock: StreamClock = {},
): AsyncGenerator<ImpEvent> {
  const ends = impdLogouts.readSignal();
  const stops = signal === undefined ? ends : AbortSignal.any([signal, ends]);

  return openEventStream({
    bus: impdEventBus,
    readSnapshot: () => {
      const at = new Date();

      return Promise.resolve(
        readImps()
          .filter((imp) => isImpAllowed(session.imps, imp.name))
          .map((imp) => ({
            v: EVENT_VERSION,
            at,
            ev: 'ImpAdded' as const,
            reason: 'snapshot' as const,
            imp,
          })),
      );
    },
    signal: stops,
    endsAt: session.expiresAt.getTime(),
    now: clock.now ?? Date.now,
    ...(clock.startTimer !== undefined && { startTimer: clock.startTimer }),
    accepts: (event) => {
      const name = 'imp' in event ? event.imp.name : event.name;

      return isImpAllowed(session.imps, name);
    },
  });
}
