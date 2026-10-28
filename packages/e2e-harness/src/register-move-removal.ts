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
  // copy, so the imp can live on the target even when `impz move` never returned.
  registerRemoval(stack, keep, async () => {
    await removeImpIfPresent(hosts.source, name);
    await removeImpIfPresent(hosts.target, name);
  });
}
