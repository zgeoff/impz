import { getErrorMessage } from '../../platform/process/get-error-message';
import { isPeerAccept } from './is-peer-accept';

// what the ACCEPT check reads, and whether it was missing at the last one
export interface PeerAcceptCheck {
  readonly readForwardRules: () => Promise<string>;
  readonly wasMissing: boolean;
  readonly log: (message: string) => void;
}

// Setup-net.sh's ACCEPT for marked traffic between imps: without it the
// imp-to-imp DROP takes every packet. Logged once until it is back. True
// while missing; a failed read keeps the last answer.
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
