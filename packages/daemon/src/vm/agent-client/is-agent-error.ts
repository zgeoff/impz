import { AgentError } from './agent-connection';
import type { AgentErrorCode } from './agent-error-codes';

export function isAgentError(
  error: unknown,
  ...codes: readonly (AgentErrorCode | 'AGENT_OUTDATED')[]
): error is AgentError {
  return error instanceof AgentError && codes.some((code) => code === error.code);
}
