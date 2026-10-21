import type { ImpState } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildInvalidStateError } from '../../surface/api-errors';

type TransitionVia = 'any' | 'warm move';

const TRANSITIONS: Readonly<Record<ImpState, Readonly<Partial<Record<ImpState, TransitionVia>>>>> =
  {
    creating: { running: 'any', stopped: 'any', error: 'any' },
    running: { stopped: 'any', sleeping: 'any', error: 'any' },
    stopped: { running: 'any', sleeping: 'warm move', error: 'any' },
    sleeping: { running: 'any', stopped: 'any', error: 'any' },
    error: { running: 'any', stopped: 'any' },
  };

const STATES: readonly ImpState[] = ['creating', 'running', 'sleeping', 'stopped', 'error'];

const VIAS: ReadonlySet<string> = new Set<TransitionVia>(['any', 'warm move']);

export function canTransition(from: ImpState, to: ImpState, via: TransitionVia = 'any'): boolean {
  if (!VIAS.has(via) || !Object.hasOwn(TRANSITIONS, from)) {
    return false;
  }

  const edges = TRANSITIONS[from];

  if (!Object.hasOwn(edges, to)) {
    return false;
  }

  const edge = edges[to];

  return edge === 'any' || edge === via;
}

export function collectStatesLeadingTo(to: ImpState, via: TransitionVia = 'any'): ImpState[] {
  return STATES.filter((from) => canTransition(from, to, via));
}

export function requireTransition(
  from: ImpState,
  to: ImpState,
  action: string,
  via: TransitionVia = 'any',
): void {
  if (!canTransition(from, to, via)) {
    throw buildInvalidStateError(from, collectStatesLeadingTo(to, via), action);
  }
}
