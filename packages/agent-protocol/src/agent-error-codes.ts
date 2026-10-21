// The Go agent sends these codes, and a contract fixture in the agent keeps its list and this one
// alike.
export const AGENT_ERROR_CODES = [
  'BAD_REQUEST',
  'DIAL_FAILED',
  'EXEC_FAILED',
  'FROZEN',
  'INNER_DOWN',
  'INTERNAL',
  'INVALID_RESUME',
  'LISTEN_FAILED',
  'NO_CONNECTION',
  'NO_SERVICE',
  'NO_SESSION',
  'NO_SPACE',
  'POWERING_OFF',
  'SERVICE_EXISTS',
  'SESSION_LIMIT',
  'UNKNOWN_OP',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];
