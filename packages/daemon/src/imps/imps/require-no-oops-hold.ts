// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildRebootNeededError } from '../../surface/api-errors';
import type { ImpVms } from './imp-context';
import type { LockedImp } from './imp-lock';

export function requireNoOopsHold(context: ImpVms, imp: Readonly<LockedImp>): void {
  if (imp.hasOopsHold && context.kernelOops.readFlag() !== 'clear') {
    throw buildRebootNeededError(imp.name);
  }
}
