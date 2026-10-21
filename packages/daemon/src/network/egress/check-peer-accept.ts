import { getErrorMessage } from '../../platform/process/get-error-message';
import { isPeerAccept } from './is-peer-accept';

export interface PeerAcceptCheck {
  readonly readForwardRules: () => Promise<string>;
  readonly wasMissing: boolean;
  readonly log: (message: string) => void;
}

export async function checkPeerAccept(check: PeerAcceptCheck): Promise<boolean> {
  try {
    const rules = await check.readForwardRules();

    const present = rules.split('\n').some((rule) => isPeerAccept(rule));

    if (!present && !check.wasMissing) {
      check.log(
        "impd: egress: setup-net.sh's imp-network ACCEPT is missing from FORWARD; imps on a network cannot reach each other until the host container starts again",
      );
    }

    return !present;
  } catch (error) {
    check.log(`impd: egress: reading FORWARD: ${getErrorMessage(error)}`);

    return check.wasMissing;
  }
}
