import {
  buildAgentOutdatedError,
  buildAgentUnknownError,
  hasFeature,
} from '../../vm/agent-client/agent-outdated';
import type { AgentFeature } from '../../vm/agent-client/agent-outdated';
import { readVmIdentity } from '../../vm/sleep/vm-identity';
import type { ImpPaths } from '../../vm/storage/data-layout';

export function requireFeature(paths: ImpPaths, feature: AgentFeature): void {
  const agentVersion = readVmIdentity(paths)?.agentVersion;

  if (!hasFeature(agentVersion, feature)) {
    throw agentVersion === undefined
      ? buildAgentUnknownError(feature)
      : buildAgentOutdatedError(feature);
  }
}
