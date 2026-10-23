import type { Revocations } from '../../identity/auth/revocations';
import type { TokenStore } from '../../identity/auth/token-store';
import type { ImpRuntime } from '../../imps/imps/imp-runtime';
import type { AuthorizedKeys } from '../../imps/ssh/authorized-keys';
import { withAuditedOpen } from '../../platform/audit/api-audit';
import type { ApiAudit } from '../../platform/audit/api-audit';
import { readImpByName } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { getErrorMessage } from '../../platform/process/get-error-message';
import type { SurfaceConfig } from '../surface-config';
import { loadOrCreateHostKey, readFingerprint, setupSshDir } from './host-key';
import { createLoginKeys } from './login-keys';
import { startSshGateway } from './ssh-gateway';
import type { SshGateway } from './ssh-gateway';

interface StartSshDeps {
  readonly config: Pick<SurfaceConfig, 'dataDir' | 'sshPort' | 'sshAuthorizedKeys'>;
  readonly db: ImpDatabase;
  readonly authorizedKeys: AuthorizedKeys;
  readonly tokens: Pick<TokenStore, 'findSshKey'>;
  readonly revocations: Pick<Revocations, 'readSignal'>;
  readonly imps: Pick<
    ImpRuntime,
    | 'requireRunning'
    | 'tracker'
    | 'openExec'
    | 'openDial'
    | 'openListener'
    | 'openAccept'
    | 'recordActivity'
  >;
  readonly log: (message: string) => void;
  readonly audit: ApiAudit;
  readonly now: () => number;
}

// Every interface of the container's own network namespace, so both the
// tailnet (tailscale0) and the published port for local use reach the gateway.
const LISTEN_HOST = '0.0.0.0';

export async function startSsh(deps: StartSshDeps): Promise<SshGateway | null> {
  const port = deps.config.sshPort;

  if (port === null) {
    return null;
  }

  const imps = deps.imps;

  try {
    const sshDir = setupSshDir(deps.config.dataDir);
    const hostKey = loadOrCreateHostKey(sshDir);

    const gateway = await startSshGateway(
      {
        hostKey,
        keys: createLoginKeys({
          findBound: deps.tokens.findSshKey,
          file: deps.config.sshAuthorizedKeys ? deps.authorizedKeys : null,
        }),
        readRevocation: deps.revocations.readSignal,
        backend: {
          requireRunning: imps.requireRunning,
          tracker: imps.tracker,
          openExec: (name, request, feature, actor) =>
            withAuditedOpen(
              deps.audit,
              {
                procedure: 'ssh',
                actor,
                impName: name,
                startedAt: deps.now(),
              },
              () => imps.openExec(name, request, feature),
            ),
          openDial: imps.openDial,
          openListener: imps.openListener,
          openAccept: imps.openAccept,
          recordActivity: imps.recordActivity,
          readImp: (name) => readImpByName(deps.db, name),
        },
        log: deps.log,
      },
      port,
      LISTEN_HOST,
    );

    deps.log(`impd: ssh on :${String(gateway.port)}, host key ${readFingerprint(hostKey)}`);

    return gateway;
  } catch (error) {
    deps.log(`impd: ssh: not started on :${String(port)}: ${getErrorMessage(error)}`);

    return null;
  }
}
