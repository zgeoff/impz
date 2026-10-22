import { deriveSlotAddress } from '../../host-net/net/addressing';
import type { TailscaleStatus } from '../../host-net/net/tailscale-status';
import type { Imps } from '../../imps/imps/imp-service';
import { readImpByName } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { isImpdError } from '../../platform/errors/impd-error';
import { runChecked, runCommand } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';
import type { NetworkConfig } from '../network-config';
import { loadOrCreateHostId } from './host-id';
import { readOAuthCredential } from './oauth-credential';
import { createServiceServe } from './service-serve';
import { createServicesApi } from './services-api';
import { createTailnetNames } from './tailnet-names';
import type { TailnetNames } from './tailnet-names';
import type { TailnetNamesConfig } from './tailnet-names-config';

interface BuildTailnetNamesOptions {
  readonly names: TailnetNamesConfig;
  readonly config: Pick<NetworkConfig, 'dataDir' | 'subnet' | 'portBase'>;
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'lockImp'>;
  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly log: (message: string) => void;

  readonly runCommand?: CommandRunner | undefined;
}

export function wireTailnetNames(options: BuildTailnetNamesOptions): TailnetNames {
  const names = options.names;

  return createTailnetNames({
    config: names,
    hostId: loadOrCreateHostId(options.config.dataDir),
    db: options.db,
    api: createServicesApi({ readCredential: () => readOAuthCredential(names.oauthFile) }),
    serve: createServiceServe((argv) => runChecked(argv, {}, options.runCommand ?? runCommand)),
    findPort: (slot) => deriveSlotAddress(slot, options.config).tailnetPort,

    isImpPresent: createPresenceCheck(options.imps, options.db),
    readSuffix: async () => {
      const status = await options.readTailscale();

      const suffix = status.dnsName?.split('.').slice(1).join('.') ?? '';

      return suffix === '' ? null : suffix;
    },
    log: options.log,
  });
}

/* @internal */
export function createPresenceCheck(
  imps: Pick<Imps, 'lockImp'>,
  db: ImpDatabase,
): (name: string) => Promise<boolean> {
  return async (name) => {
    try {
      return await imps.lockImp(name, () => Promise.resolve(true));
    } catch (error) {
      if (isImpdError(error, 'NOT_FOUND')) {
        return false;
      }

      if (isImpdError(error, 'MOVING')) {
        const imp = await readImpByName(db, name);

        return imp !== undefined && imp.moveState !== 'moved';
      }

      throw error;
    }
  };
}
