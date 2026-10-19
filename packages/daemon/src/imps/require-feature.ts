import {
  buildAgentOutdatedError,
  buildAgentUnknownError,
  hasFeature,
} from '../agent-client/agent-outdated';
import type { AgentFeature } from '../agent-client/agent-outdated';
import { readVmIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';

// fails before an old agent gets a request it cannot serve; an imp booted
// before impd recorded agent versions has none, and its answer decides
// unless the feature is strict
export function requireFeature(paths: ImpPaths, feature: AgentFeature): void {
  const agentVersion = readVmIdentity(paths)?.agentVersion;

  if (!hasFeature(agentVersion, feature)) {
    throw agentVersion === undefined
      ? buildAgentUnknownError(feature)
      : buildAgentOutdatedError(feature);
  }
}
