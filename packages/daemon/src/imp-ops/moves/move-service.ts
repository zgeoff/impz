import type { WarmHost } from '@impz/api';
import { ImpdError } from '../../platform/errors/impd-error';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { ImpOpsConfig } from '../imp-ops-config';
import { createMoveReceiver } from './move-receiver';
import type { MoveReceiver, MoveReceiverDeps } from './move-receiver';
import { createMoveSender } from './move-sender';
import type { MoveSender, MoveSenderDeps } from './move-sender';
import { buildPeerRanges } from './peer-address';
import { readWarmHost } from './warm-facts';

export type MoveService = MoveSender &
  Pick<MoveReceiver, 'issueTicket' | 'reissueTicket' | 'respond'> & {
    readonly recover: () => Promise<void>;
    readonly readFacts: () => WarmHost;
  };

type SharedKeys = 'storage' | 'imps' | 'grants' | 'egress' | 'readWarmHost';

export interface MoveServiceDeps
  extends
    Omit<MoveSenderDeps, 'ranges' | SharedKeys>,
    Omit<MoveReceiverDeps, 'ranges' | 'readPeerUrl' | SharedKeys> {
  readonly config: Pick<
    ImpOpsConfig,
    'apiPort' | 'moves' | 'dataDir' | 'subnet' | 'brokerPort' | 'dns'
  >;
  readonly storage: MoveSenderDeps['storage'] & MoveReceiverDeps['storage'];
  readonly imps: MoveSenderDeps['imps'] & MoveReceiverDeps['imps'];

  readonly grants: MoveSenderDeps['grants'] & MoveReceiverDeps['grants'];
  readonly egress: MoveSenderDeps['egress'] & MoveReceiverDeps['egress'];
  readonly readTailnetIp: () => Promise<string | null>;

  readonly readWarmHost?: () => WarmHost;
}

export function createMoveService(deps: MoveServiceDeps): MoveService {
  const ranges = buildPeerRanges(deps.config.moves.testCidr);

  if (ranges.testCidr !== null) {
    getImpdLogger('move').warning(
      'IMP_E2E=1 and IMP_MOVE_TEST_CIDR open moves to {testCidr}, off the tailnet',
      { testCidr: ranges.testCidr },
    );
  }

  const readPeerUrl = async (): Promise<string> => {
    if (deps.config.moves.peerUrl !== null) {
      return deps.config.moves.peerUrl;
    }

    const ip = await deps.readTailnetIp();

    if (ip === null) {
      throw new ImpdError('PRECONDITION_FAILED', {
        message:
          'this host is not on the tailnet, and IMP_PEER_URL is unset: it cannot receive moves',
      });
    }

    return `http://${ip}:${String(deps.config.apiPort)}`;
  };

  const readWarm =
    deps.readWarmHost ?? (() => readWarmHost(deps.config, deps.readIdentity(), deps.storage.kind));

  const sender = createMoveSender({ ...deps, ranges, readWarmHost: readWarm });
  const receiver = createMoveReceiver({ ...deps, ranges, readPeerUrl, readWarmHost: readWarm });

  return {
    ...sender,
    issueTicket: receiver.issueTicket,
    reissueTicket: receiver.reissueTicket,
    respond: receiver.respond,
    readFacts: readWarm,
    recover: async () => {
      await receiver.recover();
      await sender.recover();
    },
  };
}
