import type { NoSessionData } from '@impz/api';
import { ExecError } from './exec-error';

export class NoSessionError extends ExecError {
  declare readonly data: NoSessionData | undefined;

  constructor(message: string, data: NoSessionData | undefined) {
    super('NO_SESSION', message, { data });

    this.name = 'NoSessionError';
  }
}
