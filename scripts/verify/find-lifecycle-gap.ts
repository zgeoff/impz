import type { ImpEventStep } from './collect-imp-events.ts';

// Each step of an imp's life that the api-lifecycle journey drives, in order.
const STEPS: readonly {
  readonly what: string;
  readonly matches: (step: ImpEventStep) => boolean;
}[] = [
  {
    what: 'an ImpAdded event, reason created',
    matches: (step) => step.ev === 'ImpAdded' && step.reason === 'created',
  },
  {
    what: 'an ImpChanged event to running',
    matches: (step) => step.ev === 'ImpChanged' && step.state === 'running',
  },
  {
    what: 'an ImpChanged event to sleeping, reason slept',
    matches: (step) =>
      step.ev === 'ImpChanged' && step.state === 'sleeping' && step.reason === 'slept',
  },
  { what: 'an ImpRemoved event', matches: (step) => step.ev === 'ImpRemoved' },
];

// The first step that the events lack after the steps before it, or null when they hold every
// step in order.
export function findLifecycleGap(events: readonly ImpEventStep[]): string | null {
  let rest = events;

  for (const step of STEPS) {
    const found = rest.findIndex((event) => step.matches(event));

    if (found === -1) {
      return step.what;
    }

    rest = rest.slice(found + 1);
  }

  return null;
}
