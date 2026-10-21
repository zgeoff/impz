import type { ExecTool } from '@impz/api';
import type { AgentFeature } from '../../vm/agent-client/agent-outdated';
import type { AgentExecRequest } from '../../vm/agent-client/exec-stream';

export const SYSTEM_AGENT_PATH = '/run/imp/sys/imp-agent';
export const TOOL_FEATURES: Readonly<Record<ExecTool, AgentFeature>> = { tar: 'cp' };

export function buildToolRequest(tool: ExecTool, args: readonly string[]): AgentExecRequest {
  // `impz cp` writes where the image's user cannot and sets the owner it is given, so a tool
  // runs as root.
  return { argv: [SYSTEM_AGENT_PATH, tool, ...args], tty: false, user: 'root' };
}
