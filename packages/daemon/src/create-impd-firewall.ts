import { join } from 'node:path';
import { createBroker } from './broker/broker-service';
import type { Broker } from './broker/broker-service';
import type { SecretFiles } from './broker/secret-files';
import type { Config } from './config';
import { runNft } from './egress/egress-firewall';
import { createEgressService } from './egress/egress-service';
import type { EgressService } from './egress/egress-service';
import type { ImpdDeps } from './impd-deps';
import {
  checkHostRules6,
  readIpv6DefaultRoute,
  readOrCreateUlaPrefix,
  resolveIpv6Plan,
} from './net/ipv6-plan';
import type { Ipv6Plan } from './net/ipv6-plan';
import { printLog } from './process/print-log';
import type { ImpdStopParts } from './stop-impd';

export interface ImpdFirewall {
  readonly ipv6: Ipv6Plan | null;
  readonly broker: Broker;
  readonly egress: EgressService;
}

// The host's IPv6 plan, the credential broker and the egress firewall with
// its resolver, started before any VM runs; each goes on `plan` once made.
// The broker shares `secretFiles` with the GC, which removes what it set aside.
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

  const broker = await createBroker({
    config,
    db: deps.db,
    log,
    ipv6,
    secretFiles,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.broker,
  });

  plan.broker = broker;

  const egress = createEgressService({
    config,
    db: deps.db,
    ipv6,
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
