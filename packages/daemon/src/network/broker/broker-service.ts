import type { Socket } from 'node:net';
import { join } from 'node:path';
import type {
  AuditEntry,
  EgressMode,
  Grant,
  GrantFilter,
  GrantNotCopied,
  RefusedRequest,
  Secret,
  SecretAdded,
} from '@impz/api';
import { match } from 'ts-pattern';
import { deriveSlotAddress } from '../../host-net/net/addressing';
import type { ReachPolicy } from '../../host-net/net/reach-policy';
import { listAuditEntries, listRefusedRequests } from '../../platform/db/broker-audit';
import { createForkGrants } from '../../platform/db/create-fork-grants';
import type { ForkAuthority } from '../../platform/db/create-fork-grants';
import { listImps, readImpByName } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import {
  createCheckedGrant,
  listAllGrantedRules,
  listGrantNames,
  listGrantedRules,
  listGrants,
  removeCheckedGrant,
} from '../../platform/db/secrets';
import type { GrantAuthority, GrantClash } from '../../platform/db/secrets';
import { ImpdError } from '../../platform/errors/impd-error';
import {
  buildConflictError,
  buildForbiddenError,
  buildMovingError,
  buildNotFoundError,
} from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import type { NetworkConfig } from '../network-config';
import { loadOrCreateBrokerCa } from './broker-ca';
import { PLACEHOLDER, listPlaceholderEnv } from './connector-kinds';
import { createBrokerProxy } from './create-broker-proxy';
import { createSecretStore } from './create-secret-store';
import type { AddSecretInput } from './create-secret-store';
import { createUpstreamResolver } from './create-upstream-resolver';
import type { UpstreamFetch } from './forward-request';
import {
  buildBrokerEnv,
  buildInstallInput,
  createGuestTrust,
  runBundleInstall,
} from './guest-trust';
import type { BrokerExecEnv, InstallBundle, TrustedImp } from './guest-trust';
import { createOAuthRefresher } from './oauth-refresher';
import type { OAuthFetch } from './oauth-refresher';
import { removeStaleSecretFiles } from './remove-stale-secret-files';
import { createSecretFiles } from './secret-files';
import type { SecretFiles } from './secret-files';

interface ForkGrantsReport {
  readonly notCopied: readonly GrantNotCopied[];
  readonly error: string | null;
}

interface ForkEnd {
  readonly id: string;
  readonly name: string;
}

export interface Broker {
  readonly addSecret: (input: AddSecretInput) => Promise<SecretAdded>;
  readonly listSecrets: () => Promise<Secret[]>;

  readonly refreshSecret: (name: string) => Promise<Secret>;
  readonly deleteSecret: (name: string) => Promise<void>;

  readonly addGrant: (
    impName: string,
    secretName: string,
    authority?: Readonly<GrantAuthority> | null,
    filter?: GrantFilter,
  ) => Promise<void>;
  readonly removeGrant: (
    impName: string,
    secretName: string,
    authority?: Readonly<GrantAuthority> | null,
  ) => Promise<void>;
  readonly listGrants: (impName: string) => Promise<string[]>;

  readonly listGrantDetails: (impName: string) => Promise<Grant[]>;

  readonly listAudit: (
    impName: string | null,
    limit: number,
    patterns: readonly string[] | null,
  ) => Promise<AuditEntry[]>;

  readonly listRefused: (
    impName: string | null,
    limit: number,
    patterns: readonly string[] | null,
  ) => Promise<RefusedRequest[]>;

  readonly createForkGrants: (
    source: Readonly<ForkEnd>,
    fork: Readonly<ForkEnd>,
    authority: Readonly<ForkAuthority> | null,
  ) => Promise<ForkGrantsReport>;

  readonly readExecEnv: (imp: ImpRecord, vsockPath: string) => Promise<BrokerExecEnv>;

  readonly applyGrants: () => Promise<void>;

  readonly isGranted: (impId: string, host: string) => Promise<boolean>;

  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;

  readonly listen: (port: number) => Promise<number>;
  readonly stop: () => Promise<void>;
}

export interface BrokerDeps {
  readonly config: NetworkConfig;
  readonly db: ImpDatabase;
  readonly log: (message: string) => void;

  readonly installBundle?: InstallBundle;
  readonly fetch?: UpstreamFetch;
  readonly oauthFetch?: OAuthFetch;
  readonly now?: () => number;

  readonly runOAuthTimer?: boolean;
  readonly resolveTunnelTarget?: (host: string, mode: EgressMode) => Promise<string>;
  readonly dialTunnel?: (address: string, port: number) => Socket;

  readonly reach: ReachPolicy;

  readonly afterRuleRead?: () => Promise<void>;

  readonly beforeGrantWrite?: () => Promise<void>;
  readonly secretFiles?: SecretFiles;
}

const FORK_SKIP_CAUSES: Readonly<Record<GrantNotCopied['reason'], string>> = {
  'not-grantable': 'the caller may not grant it',
  clash: 'it has another credential for that host',
  'no-secret': 'the secret is gone',
};

const FORK_TOKEN_GONE =
  "the token behind this fork was removed, so it got none of the source's grants";

const FORK_COPY_FAILED =
  "the source's grants could not be copied, so the fork has none; impd's log has the cause";

export async function createBroker(deps: BrokerDeps): Promise<Broker> {
  const config = deps.config;
  const db = deps.db;
  const log = deps.log;
  const now = deps.now ?? Date.now;

  const ca = await loadOrCreateBrokerCa(join(config.dataDir, 'broker', 'ca'), now);

  const files = deps.secretFiles ?? createSecretFiles(config.dataDir);

  await removeStaleSecretFiles(db, files, new Date(now()), log);

  const resolveUpstream = createUpstreamResolver(config.brokerTestUpstreams, log);

  const trust = createGuestTrust(
    buildInstallInput(ca.certPem),
    deps.installBundle ?? runBundleInstall,
    log,
  );

  const unwatch = db.writes.subscribe((write) => {
    if (write.kind === 'added' || write.kind === 'changed') {
      trust.observe(write.imp);
    }
  });

  const refresher = createOAuthRefresher({
    db,
    files,
    log,
    resolveUpstream,
    ...(deps.oauthFetch !== undefined && { fetch: deps.oauthFetch }),
    ...(deps.now !== undefined && { now: deps.now }),
  });

  const proxy = createBrokerProxy({
    config,
    db,
    files,
    log,
    now,
    ca,
    resolveUpstream,
    fetch: deps.fetch,
    resolveTunnelTarget: deps.resolveTunnelTarget,
    dialTunnel: deps.dialTunnel,
    reach: deps.reach,
    afterRuleRead: deps.afterRuleRead,
    refreshAfterRejection: refresher.refreshAfterRejection,
  });

  const requireImp = async (name: string): Promise<ImpRecord> => {
    const imp = await readImpByName(db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp;
  };

  if (deps.runOAuthTimer !== false) {
    refresher.start();
  }

  const applyGrants = async (): Promise<void> => {
    try {
      const [granted, imps] = await Promise.all([listAllGrantedRules(db), listImps(db)]);

      const live = new Set(granted.map((entry) => `${entry.impId}\n${entry.rule.host}`));

      await proxy.prune((key) => live.has(`${key.impId}\n${key.host}`));

      trust.forgetExcept(new Set(imps.map((imp) => imp.id)));
    } catch (error) {
      log(`impd: broker: could not apply grants: ${getErrorMessage(error)}`);
    }
  };

  const secrets = createSecretStore({ db, files, log, refresher, applyGrants });

  return {
    addSecret: secrets.addSecret,
    listSecrets: secrets.listSecrets,
    refreshSecret: secrets.refreshSecret,
    deleteSecret: secrets.removeSecret,

    addGrant: async (impName, secretName, authority, filter) => {
      const imp = await requireImp(impName);

      if (imp.moveState === 'sending' || imp.moveState === 'moved') {
        throw buildMovingError(impName);
      }

      if (deps.beforeGrantWrite !== undefined) {
        await deps.beforeGrantWrite();
      }

      const outcome = await createCheckedGrant(db, {
        impId: imp.id,
        secretName,
        authority: authority ?? null,
        filter,
      });

      if (outcome.kind === 'granted') {
        return;
      }

      throw match(outcome)
        .with({ kind: 'no-secret' }, () => buildNotFoundError('secret', secretName))
        .with({ kind: 'no-token' }, () => buildTokenGoneError())
        .with({ kind: 'not-grantable' }, () => buildStaleError(secretName))
        .with({ kind: 'clash' }, (refused) => buildClashError(impName, secretName, refused.clash))
        .exhaustive();
    },

    removeGrant: async (impName, secretName, authority = null) => {
      const imp = await requireImp(impName);

      if (imp.moveState !== null) {
        throw buildMovingError(impName);
      }

      if (deps.beforeGrantWrite !== undefined) {
        await deps.beforeGrantWrite();
      }

      const outcome = await removeCheckedGrant(db, imp.id, secretName, authority);

      if (outcome.kind === 'no-token') {
        throw buildTokenGoneError();
      }

      if (outcome.kind === 'not-grantable') {
        throw buildStaleError(secretName);
      }

      if (outcome.kind === 'no-grant') {
        throw buildNotFoundError('grant', `${impName}/${secretName}`);
      }

      await applyGrants();
    },

    listGrants: async (impName) => {
      const imp = await requireImp(impName);

      return listGrantNames(db, imp.id);
    },

    listGrantDetails: async (impName) => {
      const imp = await requireImp(impName);

      return listGrants(db, imp.id);
    },

    listAudit: async (impName, limit, patterns) => {
      const imp = impName === null ? null : await requireImp(impName);

      return listAuditEntries(db, imp?.id ?? null, Math.min(limit, 1000), patterns);
    },

    listRefused: async (impName, limit, patterns) => {
      const imp = impName === null ? null : await requireImp(impName);

      return listRefusedRequests(db, imp?.id ?? null, Math.min(limit, 1000), patterns);
    },

    createForkGrants: async (source, fork, authority) => {
      if (deps.beforeGrantWrite !== undefined) {
        await deps.beforeGrantWrite();
      }

      try {
        const outcome = await createForkGrants(db, source.id, fork.id, authority);

        if (outcome.kind === 'no-token') {
          log(
            `impd: ${fork.name}: forked without the grants of ${source.name}: the token was removed`,
          );

          return { notCopied: [], error: FORK_TOKEN_GONE };
        }

        for (const skipped of outcome.notCopied) {
          log(
            `impd: ${fork.name}: forked without grant ${skipped.secret} of ${source.name}: ${FORK_SKIP_CAUSES[skipped.reason]}`,
          );
        }

        return { notCopied: outcome.notCopied, error: null };
      } catch (error) {
        log(
          `impd: ${fork.name}: forked without the grants of ${source.name}: ${getErrorMessage(error)}`,
        );

        return { notCopied: [], error: FORK_COPY_FAILED };
      }
    },

    readExecEnv: async (imp, vsockPath) => {
      const granted = await listGrantedRules(db, imp.id);

      if (granted.length === 0) {
        return { kind: 'ungranted' };
      }

      const trusted: TrustedImp = { id: imp.id, name: imp.name, pid: imp.pid };

      const outcome = await trust.ensure(trusted, vsockPath);

      if (!outcome.installed) {
        return { kind: 'untrusted', detail: outcome.detail };
      }

      const gateway = deriveSlotAddress(imp.slot, {
        subnet: config.subnet,
        portBase: config.portBase,
      }).hostIp;

      const env = buildBrokerEnv({
        proxyUrl: `http://${gateway}:${String(proxy.getPort())}`,
        placeholders: listPlaceholderEnv(granted.map((entry) => entry.kind)),
        placeholder: PLACEHOLDER,
      });

      return { kind: 'ready', env };
    },

    applyGrants,

    closeTunnels: proxy.closeTunnels,

    isGranted: proxy.isGranted,

    listen: proxy.listen,

    stop: async () => {
      unwatch();

      await refresher.stop();
      await proxy.stop();
    },
  };
}

function buildTokenGoneError() {
  return new ImpdError('UNAUTHORIZED', { message: 'the token behind this call was removed' });
}

function buildStaleError(secretName: string) {
  return buildForbiddenError(
    `secret ${secretName} is not one this caller may grant`,
    'not_grantable',
  );
}

function buildClashError(impName: string, secretName: string, clash: Readonly<GrantClash>) {
  return buildConflictError(
    'grant',
    `${impName}/${secretName}`,
    `secret ${clash.secretName} already gives ${impName} a credential for ${clash.host}`,
  );
}
