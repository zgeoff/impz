import { ORPCError } from '@orpc/server';
import { ImpdError } from '../platform/errors/impd-error';

export function toORPCError(error: unknown): unknown {
  if (!(error instanceof ImpdError)) {
    return error;
  }

  return new ORPCError(error.code, {
    ...(error.status !== undefined && { status: error.status }),
    message: error.message,
    data: error.data,
    cause: error.cause,
  });
}
