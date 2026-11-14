import { WringerError } from '@wringer/core';
import type { Endpoints } from '@wringer/core';
import { parseRunEndpoints } from './run-endpoints.ts';

// The doctor's `host` check: the target's app put no reason in its ready line why this machine
// cannot run it.
export function checkHost(endpoints: Endpoints): Promise<null> {
  const blocked = parseRunEndpoints(endpoints).blocked;

  if (blocked !== '') {
    return Promise.reject(new WringerError('check-failed', { message: blocked }));
  }

  return Promise.resolve(null);
}
