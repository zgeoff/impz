import type { ImpClient } from '@impz/client';
import { registerRemoval } from './register-removal';
import { removeImpIfPresent } from './reset-baseline';

interface MoveHostClients {
  readonly source: ImpClient;
  readonly target: ImpClient;
}

export function registerMoveRemoval(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  keep: boolean,
  hosts: Readonly<MoveHostClients>,
  name: string,
): void {
  // impd answers an abort of a move the target already committed by destroying the source's
  // copy, so the imp can live on the target even when `impz move` never returned. The stack
  // runs the last removal first, and runs each one when another throws.
  registerRemoval(stack, keep, () => removeImpIfPresent(hosts.target, name));
  registerRemoval(stack, keep, () => removeImpIfPresent(hosts.source, name));
}
