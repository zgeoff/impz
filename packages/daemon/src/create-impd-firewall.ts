import { join } from 'node:path';
import type { Config } from './config';
import {
  readConnectedPrefixes,
  readIpv6DefaultRoute,
  readUplinks,
} from './host-net/net/host-routes';
import { checkHostRules6, readOrCreateUlaPrefix, resolveIpv6Plan } from './host-net/net/ipv6-plan';
import type { Ipv6Plan } from './host-net/net/ipv6-plan';
import { createReachPolicy } from './host-net/net/reach-policy';
import type { ImpdDeps } from './impd-deps';
import { createBroker } from './network/broker/broker-service';
import type { Broker } from './network/broker/broker-service';
import type { SecretFiles } from './network/broker/secret-files';
import { runNft } from './network/egress/egress-firewall';
import { createEgressService } from './network/egress/egress-service';
import type { EgressService } from './network/egress/egress-service';
import { printLog } from './platform/process/print-log';
import type { ImpdStopParts } from './stop-impd';

export interface ImpdFirewall {
  readonly ipv6: Ipv6Plan | null;
  readonly broker: Broker;
  readonly egress: EgressService;
}

export async function createImpdFirewall(
  config: Config,
  deps: Readonly<ImpdDeps>,
  secretFiles: SecretFiles,
  plan: Pick<ImpdStopParts, 'broker' | 'egress'>,
): Promise<ImpdFirewall> {
  const log = deps.log ?? printLog;

  const ipv6 = await (
    deps.resolveIpv6 ??
    (() =>
      resolveIpv6Plan(config.ipv6, {
        readDefaultRoute: readIpv6DefaultRoute,
        readUlaPrefix: () => readOrCreateUlaPrefix(join(config.dataDir, 'net', 'ipv6-ula')),
        checkHostRules: () => checkHostRules6(),
        runNft: deps.egress?.runNft ?? runNft,
        log,
      }))
  )();

  const reach = createReachPolicy({
    subnet: config.subnet,
    deny: config.egressDeny,
    ipv6,
    now: deps.now ?? Date.now,
    readConnected4: () => readConnectedPrefixes('ipv4'),
    readConnected6: () => readConnectedPrefixes('ipv6'),
    readUplinks: () => readUplinks(),
    ...deps.reach,
  });

  const broker = await createBroker({
    config,
    db: deps.db,
    log,
    reach,
    secretFiles,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.broker,
  });

  plan.broker = broker;

  const egress = createEgressService({
    config,
    db: deps.db,
    ipv6,
    reach,
    log,
    isGranted: broker.isGranted,
    closeTunnels: broker.closeTunnels,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.egress,
  });

  plan.egress = egress;

  await egress.start();

  return { ipv6, broker, egress };
}
