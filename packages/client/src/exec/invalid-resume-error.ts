import type { InvalidResumeData } from '@impz/api';
import { ExecError } from './exec-error';

export class InvalidResumeError extends ExecError {
  declare readonly data: InvalidResumeData;

  constructor(message: string, data: InvalidResumeData) {
    super('INVALID_RESUME', message, { data });

    this.name = 'InvalidResumeError';
  }
}
