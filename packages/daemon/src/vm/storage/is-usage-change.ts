import type { ImpChangeReason } from '@impz/api';
import { P, match } from 'ts-pattern';
import type { ImpLogEntry } from '../../platform/db/imp-log-entry';

// a stop or a sleep changes disk use too, as the guest writes its cache and memory out
const CHANGES_USAGE: ReadonlySet<ImpChangeReason> = new Set([
  'resized',
  'restored',
  'stopped',
  'slept',
]);

export function isUsageChange(event: Readonly<ImpLogEntry>): boolean {
  return match(event)
    .with(
      { ev: P.union('ImpAdded', 'ImpRemoved', 'CheckpointAdded', 'CheckpointRemoved') },
      () => true,
    )
    .with({ ev: 'ImpChanged' }, (changed) => CHANGES_USAGE.has(changed.reason))
    .with({ ev: P.union('GovernorDecision', 'AgentExec') }, () => false)
    .exhaustive();
}
