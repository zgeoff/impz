import type { AgentErrorCode } from '@impz/agent-protocol';
import { AgentError } from './agent-connection';

export function isAgentError(
  error: unknown,
  ...codes: readonly (AgentErrorCode | 'AGENT_OUTDATED')[]
): error is AgentError {
  return error instanceof AgentError && codes.some((code) => code === error.code);
}
