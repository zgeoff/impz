import { ImpEventSchema } from '@impz/api';
import type { ImpEvent } from '@impz/api';
import { metrics } from '@opentelemetry/api';
import { SCOPE } from '../telemetry/scope';

const LOG_INTERVAL_MS = 5 * 60_000;

interface EventCheckDeps {
  readonly log: (message: string) => void;
  readonly now: () => number;
}

interface DropLog {
  loggedAt: number | null;
  count: number;
}

// oRPC ends a stream on an event that fails the schema, so such an event
// stays off the wire; impd's own subscribers still get it from the bus.
export function createEventCheck(deps: EventCheckDeps): (event: Readonly<ImpEvent>) => boolean {
  const dropped = metrics.getMeter(SCOPE).createCounter('imp.events.dropped', {
    description: 'events the stream dropped because they fail the event schema, a bug in impd',
  });

  const checked = new WeakMap<Readonly<ImpEvent>, boolean>();
  const drops = new Map<string, DropLog>();

  const countDrop = (ev: string, issue: string): void => {
    dropped.add(1, { ev });

    const drop = drops.get(ev) ?? { loggedAt: null, count: 0 };

    drops.set(ev, drop);

    drop.count += 1;

    const time = deps.now();

    if (drop.loggedAt !== null && time - drop.loggedAt < LOG_INTERVAL_MS) {
      return;
    }

    deps.log(
      `impd: dropped ${drop.count} ${ev} event(s) that fail the event schema; the latest at ${issue}`,
    );

    drop.loggedAt = time;
    drop.count = 0;
  };

  return (event) => {
    const known = checked.get(event);

    if (known !== undefined) {
      return known;
    }

    const parsed = ImpEventSchema.safeParse(event);

    checked.set(event, parsed.success);

    if (!parsed.success) {
      // the first issue, on one line: z.prettifyError spans several
      const [issue] = parsed.error.issues.map((each) => `${each.path.join('.')}: ${each.message}`);

      countDrop(event.ev, issue ?? 'no issue');
    }

    return parsed.success;
  };
}
