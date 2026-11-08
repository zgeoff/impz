import { P, match } from 'ts-pattern';
import type { ImpLogEntry } from './imp-log-entry';

// Ports and grants follow the logged event, never its API form, so a failure to present an
// imp cannot leave a port open or closed.
export function isImpSetChange(event: Readonly<ImpLogEntry>): boolean {
  return match(event)
    .with({ ev: P.union('ImpAdded', 'ImpRemoved') }, () => true)
    .with({ ev: 'ImpChanged' }, (changed) => changed.reason === 'stopped')
    .with(
      { ev: P.union('CheckpointAdded', 'CheckpointRemoved', 'GovernorDecision', 'AgentExec') },
      () => false,
    )
    .exhaustive();
}
