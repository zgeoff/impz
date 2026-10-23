import { ORPCError } from '@orpc/server';
import { ImpdError } from '../platform/errors/impd-error';

export function readErrorCode(failure: unknown): string {
  return failure instanceof ImpdError || failure instanceof ORPCError
    ? String(failure.code)
    : 'INTERNAL_SERVER_ERROR';
}
