import { buildRebootNeededError } from '../../surface/api-errors';
import type { ImpVms } from './imp-context';
import type { LockedImp } from './imp-lock';

// The task an oops killed holds the imp's disk until the host reboots: no VM
// boots or wakes on it before a read of the taint flag clear proves that.
export function requireNoOopsHold(context: ImpVms, imp: Readonly<LockedImp>): void {
  if (imp.hasOopsHold && context.kernelOops.readFlag() !== 'clear') {
    throw buildRebootNeededError(imp.name);
  }
}
