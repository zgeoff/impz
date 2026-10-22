import type { Socket } from 'node:net';
import { join } from 'node:path';
import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { EgressMode } from '@impz/api';
import { readRouteDevice } from '../../host-net/net/host-routes';
import type { Ipv6Plan } from '../../host-net/net/ipv6-plan';
import { createReachPolicy } from '../../host-net/net/reach-policy';
import type { ReachPolicy } from '../../host-net/net/reach-policy';
import { writeAuditEntry } from '../../platform/db/broker-audit';
import type { NewAuditEntry } from '../../platform/db/broker-audit';
import type { ImpDatabase } from '../../platform/db/open-database';
import { readBrokerPeer } from '../../platform/db/read-broker-peer';
import { listGrantedRules } from '../../platform/db/secrets';
import type { GrantedRule } from '../../platform/db/secrets';
import { getErrorMessage } from '../../platform/process/get-error-message';
import type { NetworkConfig } from '../network-config';
import type { BrokerCa } from './broker-ca';
import { startBrokerFront } from './broker-front';
import type { BrokerFront } from './broker-front';
import { renderCredential } from './connector-kinds';
import type { ResolveUpstream } from './create-upstream-resolver';
import { createForwarder } from './forward-request';
import type { Credential, ForwardDeps, UpstreamFetch } from './forward-request';
import { parseOAuthState } from './oauth-state';
import { createRefusalBudget } from './refusal-budget';
import type { SecretFiles } from './secret-files';
import { createTerminators } from './terminators';
import type { TerminatorKey } from './terminators';
import { requireUplinkRoute, resolveTunnelTarget } from './tunnel-target';

interface BrokerProxy {
  readonly isGranted: (impId: string, host: string) => Promise<boolean>;

  readonly prune: (keep: (key: TerminatorKey) => boolean) => Promise<void>;

  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;

  readonly listen: (port: number) => Promise<number>;

  readonly getPort: () => number;
  readonly stop: () => Promise<void>;
}

interface BrokerProxyDeps {
  readonly config: NetworkConfig;
  readonly db: ImpDatabase;
  readonly files: Pick<SecretFiles, 'read'>;
  readonly log: (message: string) => void;
  readonly now: () => number;
  readonly ca: BrokerCa;
  readonly resolveUpstream: ResolveUpstream;
  readonly fetch?: UpstreamFetch | undefined;
  readonly resolveTunnelTarget?: ((host: string, mode: EgressMode) => Promise<string>) | undefined;
  readonly dialTunnel?: ((address: string, port: number) => Socket) | undefined;
  readonly ipv6?: Ipv6Plan | null | undefined;
  readonly reach?: ReachPolicy | undefined;
  readonly afterRuleRead?: (() => Promise<void>) | undefined;

  readonly refreshAfterRejection?: ForwardDeps['refreshAfterRejection'] | undefined;
}

const REFUSED_AUDITS_PER_SECOND = 20;

export function createBrokerProxy(deps: BrokerProxyDeps): BrokerProxy {
  const config = deps.config;
  const db = deps.db;
  const files = deps.files;
  const log = deps.log;
  const now = deps.now;
  const ca = deps.ca;

  const reach =
    deps.reach ??
    createReachPolicy({
      subnet: config.subnet,
      deny: config.egressDeny,
      ipv6: deps.ipv6 ?? null,
      now,
    });

  const resolveTarget = async (host: string, mode: EgressMode): Promise<string> => {
    const isPublic = EGRESS_MODE_TRAITS[mode].isPublic;

    const hostReach = await reach.readCached(isPublic);

    const address = await resolveTunnelTarget(host, {
      isRefused: (target) => hostReach.isRefused(target, isPublic),
      hasIPv6: reach.hasIPv6,
    });

    if (isPublic) {
      await requireUplinkRoute(host, address, hostReach.uplinks, readRouteDevice);
    }

    return address;
  };

  const readRule = async (impId: string, host: string): Promise<GrantedRule | undefined> => {
    const rules = await listGrantedRules(db, impId);

    return rules.find((granted) => granted.rule.host === host);
  };

  const readCredential = async (impId: string, host: string): Promise<Credential | null> => {
    const granted = await readRule(impId, host);

    await deps.afterRuleRead?.();

    const stored = granted === undefined ? null : files.read(granted.valueFile);
    const oauth = granted?.kind === 'oauth' && stored !== null ? parseOAuthState(stored) : null;
    const value = granted?.kind === 'oauth' ? (oauth?.accessToken ?? null) : stored;

    if (granted === undefined || value === null) {
      return null;
    }

    return {
      secretName: granted.secretName,
      header: granted.rule.header,
      value: renderCredential(granted.rule, value),
      upstream: granted.rule.upstream ?? null,
      filter: granted.filter,
      oauth: oauth === null ? null : { refreshedAt: oauth.refreshedAt },
    };
  };

  const writeAudit = async (entry: Readonly<NewAuditEntry>): Promise<void> => {
    try {
      await writeAuditEntry(db, entry);
    } catch (error) {
      log(`impd: broker: audit write failed: ${getErrorMessage(error)}`);
    }
  };

  const refusals = createRefusalBudget({ perSecond: REFUSED_AUDITS_PER_SECOND, now });

  const writeBudgetedAudit = (entry: NewAuditEntry): void => {
    if (entry.reason === null || refusals.tryClaim(entry.impId)) {
      void writeAudit(entry);
    }
  };

  const terminators = createTerminators({
    socketDir: join(config.dataDir, 'broker', 'run'),
    issueLeaf: ca.issueLeaf,
    isLeafDue: (leaf) => ca.isDue(leaf, now()),
    createHandler: (key) =>
      createForwarder({
        impId: key.impId,
        impName: key.impName,
        host: key.host,
        findCredential: readCredential,
        resolveUpstream: deps.resolveUpstream,
        recordAudit: writeBudgetedAudit,
        ...(deps.fetch !== undefined && { fetch: deps.fetch }),
        ...(deps.refreshAfterRejection !== undefined && {
          refreshAfterRejection: deps.refreshAfterRejection,
        }),
      }),
  });

  const state: { front: BrokerFront | null; port: number } = {
    front: null,
    port: config.brokerPort,
  };

  const probeGranted = async (impId: string, host: string): Promise<boolean> =>
    (await readRule(impId, host)) !== undefined;

  return {
    isGranted: probeGranted,

    prune: (keep) => terminators.prune(keep),

    closeTunnels: (impId, keep) => {
      state.front?.closeTunnels(impId, keep);
    },

    listen: async (port) => {
      const front = await startBrokerFront(port, {
        subnet: config.subnet,
        readPeer: (slot) => readBrokerPeer(db, slot),
        isGranted: probeGranted,
        openTerminator: terminators.open,
        resolveTunnelTarget: deps.resolveTunnelTarget ?? resolveTarget,
        ...(deps.dialTunnel !== undefined && { dialTunnel: deps.dialTunnel }),
        recordAudit: writeBudgetedAudit,
        log,
      });

      const address = front.server.address();

      state.front = front;
      state.port = typeof address === 'object' && address !== null ? address.port : port;

      return state.port;
    },

    getPort: () => state.port,

    stop: async () => {
      await state.front?.stop();
      await terminators.stop();
    },
  };
}
