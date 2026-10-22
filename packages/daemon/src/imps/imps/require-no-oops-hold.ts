import { buildRebootNeededError } from '../../platform/errors/impd-errors';
import type { ImpVms } from './imp-context';
import type { LockedImp } from './imp-lock';

export function requireNoOopsHold(context: ImpVms, imp: Readonly<LockedImp>): void {
  if (imp.hasOopsHold && context.kernelOops.readFlag() !== 'clear') {
    throw buildRebootNeededError(imp.name);
  }
}
