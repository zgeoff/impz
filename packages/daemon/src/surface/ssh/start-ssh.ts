import type { Revocations } from '../../identity/auth/revocations';
import type { TokenStore } from '../../identity/auth/token-store';
import type { ImpRuntime } from '../../imps/imps/imp-runtime';
import type { ImpService } from '../../imps/imps/imp-service';
import type { AuthorizedKeys } from '../../imps/ssh/authorized-keys';
import { withAuditedOpen } from '../../platform/audit/api-audit';
import type { ApiAudit } from '../../platform/audit/api-audit';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { SurfaceConfig } from '../surface-config';
import { loadOrCreateHostKey, readFingerprint, setupSshDir } from './host-key';
import { createLoginKeys } from './login-keys';
import { startSshGateway } from './ssh-gateway';
import type { SshGateway } from './ssh-gateway';

interface StartSshDeps {
  readonly config: Pick<SurfaceConfig, 'dataDir' | 'sshPort' | 'sshAuthorizedKeys'>;
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
  > &
    Pick<ImpService, 'readImpRecord'>;
  readonly audit: Pick<ApiAudit, 'record'>;
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
          readImp: imps.readImpRecord,
        },
      },
      port,
      LISTEN_HOST,
    );

    getImpdLogger('ssh').info('ssh on :{port}, host key {hostKey}', {
      port: String(gateway.port),
      hostKey: readFingerprint(hostKey),
    });

    return gateway;
  } catch (error) {
    getImpdLogger('ssh').warning('not started on :{port}: {error}', {
      port: String(port),
      error: getErrorMessage(error),
    });

    return null;
  }
}
