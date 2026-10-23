import type { Scope } from '@impz/api';
import type { Caller } from '../platform/principal/caller';
import { findImpRefusal } from './find-imp-refusal';

export function requireNamedImp(
  caller: Readonly<Caller>,
  name: string | undefined,
  scope: Scope = 'read',
): void {
  const refusal = name === undefined ? null : findImpRefusal(caller, scope, name, 'touch');

  if (refusal !== null) {
    throw refusal;
  }
}
