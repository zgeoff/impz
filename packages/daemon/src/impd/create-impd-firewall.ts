import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config';
import { checkHostRules6, readOrCreateUlaPrefix, resolveIpv6Plan } from '../host-net/net/ipv6-plan';
import type { Ipv6Plan } from '../host-net/net/ipv6-plan';
import { createReachPolicy } from '../host-net/net/reach-policy';
import {
  readConnectedPrefixes,
  readIpv6DefaultRoute,
  readUplinks,
} from '../host-net/net/read-uplinks';
import type { BuilderTestRegistry } from '../imps/images/builders/create-builders';
import { createBroker } from '../network/broker/broker-service';
import type { BrokerService } from '../network/broker/broker-service';
import type { SecretFiles } from '../network/broker/secrets/secret-files';
import { resolvePublicUpstream } from '../network/broker/tls/resolve-public-upstream';
import { createUpstreamResolver } from '../network/create-upstream-resolver';
import { createEgressService } from '../network/egress/egress-service';
import type { EgressService } from '../network/egress/egress-service';
import { runNft } from '../network/egress/run-nft';
import { resolveTestRegistry } from '../resolve-test-registry';
import type { ImpdDeps } from './impd-deps';
import type { ImpdStopParts } from './stop-impd';

export interface ImpdFirewall {
  readonly ipv6: Ipv6Plan | null;
  readonly broker: BrokerService;
  readonly egress: EgressService;
  readonly testRegistry: BuilderTestRegistry | null;
}

export async function createImpdFirewall(
  config: Config,
  deps: Readonly<ImpdDeps>,
  secretFiles: SecretFiles,
  plan: Pick<ImpdStopParts, 'broker' | 'egress'>,
): Promise<ImpdFirewall> {
  const ipv6 = await (
    deps.resolveIpv6 ??
    (() =>
      resolveIpv6Plan(config.ipv6, {
        readDefaultRoute: readIpv6DefaultRoute,
        readUlaPrefix: () => readOrCreateUlaPrefix(join(config.dataDir, 'net', 'ipv6-ula')),
        checkHostRules: () => checkHostRules6(),
        runNft: deps.egress?.runNft ?? runNft,
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
    reach,
    resolveUpstream:
      config.brokerTestUpstreams === null
        ? resolvePublicUpstream
        : createUpstreamResolver(config.brokerTestUpstreams),
    secretFiles,
    ...(deps.now !== undefined && { now: deps.now }),
    timer: deps.tickerTimer,
    ...deps.broker,
  });

  plan.broker = broker;

  const testRegistry = await resolveTestRegistry(config.build.testRegistry, {
    readAddress: async (name) => {
      const resolved = await lookup(name, { family: 4 });

      return resolved.address;
    },
    readCA: (path) => readFile(path, 'utf8'),
    ...deps.testRegistry,
  });

  const egress = createEgressService({
    config,
    db: deps.db,
    ipv6,
    reach,
    testRegistry,
    isGranted: broker.isGranted,
    closeTunnels: broker.closeTunnels,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.egress,
  });

  plan.egress = egress;

  await egress.start();

  return { ipv6, broker, egress, testRegistry };
}
