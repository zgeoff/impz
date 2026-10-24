import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { isPeerAccept } from './is-peer-accept';

export interface PeerAcceptCheck {
  readonly readForwardRules: () => Promise<string>;
  readonly wasMissing: boolean;
}

export async function checkPeerAccept(check: PeerAcceptCheck): Promise<boolean> {
  try {
    const rules = await check.readForwardRules();

    const present = rules.split('\n').some((rule) => isPeerAccept(rule));

    if (!present && !check.wasMissing) {
      getImpdLogger('egress').warning(
        "setup-net.sh's imp-network ACCEPT is missing from FORWARD; imps on a network cannot reach each other until the host container starts again",
      );
    }

    return !present;
  } catch (error) {
    getImpdLogger('egress').warning('reading FORWARD: {error}', { error: getErrorMessage(error) });

    return check.wasMissing;
  }
}
