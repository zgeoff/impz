import { ImpdError } from '../../platform/errors/impd-error';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { AgentError } from '../agent-client/agent-connection';

export interface GuestFailure {
  readonly code?: string;
  readonly message: string;
  readonly data?: unknown;
}

export function buildGuestFailure(error: unknown): GuestFailure {
  if (error instanceof ImpdError) {
    const data: unknown = error.data;

    return {
      code: String(error.code),
      message: error.message,
      ...(data !== undefined && { data }),
    };
  }

  if (error instanceof AgentError) {
    const data: unknown = error.data;

    return { code: error.code, message: error.detail, ...(data !== undefined && { data }) };
  }

  return { message: getErrorMessage(error) };
}
