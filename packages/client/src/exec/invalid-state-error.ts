import type { IMP_ERRORS } from '@impz/api';
import type { ReadonlyFields } from '@impz/shared';
import type * as z from 'zod';
import { ExecError } from './exec-error';

export type InvalidStateData = ReadonlyFields<z.infer<typeof IMP_ERRORS.INVALID_STATE.data>>;

export class InvalidStateError extends ExecError {
  declare readonly data: InvalidStateData;

  constructor(message: string, data: Readonly<InvalidStateData>) {
    super('INVALID_STATE', message, { data });

    this.name = 'InvalidStateError';
  }
}
