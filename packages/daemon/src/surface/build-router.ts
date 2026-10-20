import { EVENT_VERSION, hasScope, isImpAllowed } from '@impz/api';
import type { Imp, ImpEvent } from '@impz/api';
import type { Config } from '../config';
import type { TailscaleStatus } from '../host-net/net/tailscale-status';
import { findForkAuthority } from '../identity/auth/access-policy';
import { formatCaller, isCallerAllowed } from '../identity/auth/caller';
import type { Caller } from '../identity/auth/caller';
import {
  isLeaseVisible,
  requireLeaseHolder,
  toApiLease,
  toLeaseSummary,
} from '../identity/auth/caller-view';
import type { TokenStore } from '../identity/auth/token-store';
import type { McpAuth } from '../identity/oauth/create-mcp-auth';
import { buildBackupsOffError } from '../imp-ops/backup/backup-service';
import type { BackupService } from '../imp-ops/backup/backup-service';
import type { CheckpointService } from '../imp-ops/checkpoints/checkpoint-service';
import type { MoveService } from '../imp-ops/moves/move-service';
import type { Repeat } from '../imps/images/build-event-stream';
import type { ImageService } from '../imps/images/image-service';
import type { TemplateService } from '../imps/images/template-service';
import { readPresentedLeases } from '../imps/imps/imp-presenter';
import type { ImpService } from '../imps/imps/imp-service';
import type { Broker } from '../network/broker/broker-service';
import type { EgressService } from '../network/egress/egress-service';
import type { DnsTokenStatus } from '../network/https/dns/dns-token';
import { createExposureService } from '../network/https/exposure-service';
import type { PublicRecordsLink } from '../network/https/public-records-link';
import type { NetworkService } from '../network/networks/network-service';
import type { TailnetNamesStatus } from '../network/tailnet-names/tailnet-names';
import type { ApiAudit } from '../platform/audit/api-audit';
import type { ImpDatabase } from '../platform/db/open-database';
import { createEventCheck } from '../platform/events/event-check';
import { openEventStream } from '../platform/events/event-stream';
import { mergeSignals } from '../platform/process/merge-signals';
import type { RamGovernor } from '../vm/governor/ram-governor';
import type { DiskBudget } from '../vm/storage/disk-budget';
import type { StorageBackend } from '../vm/storage/storage-backend';
import type { StorageGcService } from '../vm/storage/storage-gc';
import type { SystemFileInfo } from '../vm/storage/system-file-info';
import type { KsmHostStats } from '../vm/vmm/ksm';
import { buildForbiddenError } from './api-errors';
import { buildAuditRoutes } from './build-audit-routes';
import { buildGrantRoutes } from './build-grant-routes';
import { buildImageRoutes } from './build-image-routes';
import { buildImplementer } from './build-implementer';
import { buildNetworkRoutes } from './build-network-routes';
import { buildOAuthRoutes } from './build-oauth-routes';
import { buildSecretRoutes } from './build-secret-routes';
import { buildSystemRoutes } from './build-system-routes';
import { buildTokenRoutes } from './build-token-routes';
import type { ExecTickets } from './exec/exec-tickets';
import { requireNamedImp } from './require-named-imp';

// log lines `services.logs` sends first when the caller names no count
const DEFAULT_LOG_LINES = 100;

export interface RouterDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: ImpService;
  readonly images: ImageService;
  readonly governor: RamGovernor;
  readonly checkpoints: CheckpointService;
  readonly templates: TemplateService;
  readonly broker: Broker;
  readonly egress: Pick<EgressService, 'readPolicy' | 'setPolicy' | 'isEnforced'>;
  readonly networks: NetworkService;

  // null when no repository is set
  readonly backups: BackupService | null;
  readonly moves: Omit<MoveService, 'handle' | 'recover'>;
  readonly firecrackerVersion: string | null;
  readonly systemFiles: SystemFileInfo;

  // the host's KSM counters; null without KSM
  readonly readKsmHostStats?: () => KsmHostStats | null;
  readonly readTailscale: () => Promise<TailscaleStatus>;

  // per-imp names on the tailnet; null when IMP_TAILNET_NAMES is off
  readonly readTailnetNames: (() => TailnetNamesStatus) | null;

  // the HTTPS service's public records, once it runs
  readonly publicRecords: PublicRecordsLink;

  // reads the DNS API token now; null for a provider without one
  readonly checkDnsToken: (() => Promise<DnsTokenStatus>) | null;
  readonly execTickets: ExecTickets;
  readonly storage: Pick<StorageBackend, 'kind' | 'readWarnings'>;
  readonly diskBudget: Pick<DiskBudget, 'readStatus' | 'withRoom'>;
  readonly gc: Pick<StorageGcService, 'runGc'>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly audit: ApiAudit;
  readonly tokens: TokenStore;

  // the gap between progress events of a streamed image add or build
  readonly imageKeepaliveMs: number;

  // the timer of those progress events; runOnInterval by default
  readonly imageKeepaliveRepeat?: Repeat;

  // OAuth for the public MCP route (docs/guides/mcp.md#public-route)
  readonly oauth: McpAuth;
}

export function buildRouter(deps: RouterDeps) {
  const exposure = createExposureService({
    db: deps.db,
    https: deps.config.https,
    updateRecords: deps.publicRecords.update,
  });

  const os = buildImplementer(deps);

  // the caller's imps as its event stream opens
  const readSnapshot = async (caller: Readonly<Caller>): Promise<ImpEvent[]> => {
    const imps = await listCallerImps(caller);

    const at = new Date(deps.now());

    return imps.map((imp) => ({ v: EVENT_VERSION, at, ev: 'ImpAdded', reason: 'snapshot', imp }));
  };

  // one for every stream: each event is checked once, whoever reads it
  const isEventValid = createEventCheck({ log: deps.log, now: deps.now });

  const listCallerImps = async (caller: Readonly<Caller>) => {
    const imps = await deps.imps.listImps();

    return imps.filter((imp) => isImpAllowed(caller.imps, imp.name));
  };

  // The presenter shows an imp's leases as a count; the caller sees its own,
  // or every owner with host-wide manage. The records are the ones the
  // presenter read; an imp from elsewhere has its read here.
  const toCallerImps = async (caller: Readonly<Caller>, imps: readonly Imp[]): Promise<Imp[]> => {
    const unread = imps.filter((imp) => readPresentedLeases(imp) === undefined);

    const byImp = await deps.imps.readLeases(unread.map((imp) => imp.id));

    return imps.map((imp) => {
      const leases = readPresentedLeases(imp) ?? byImp.get(imp.id) ?? [];

      return { ...imp, leases: toLeaseSummary(caller, imp.name, leases) };
    });
  };

  const toCallerImp = async (caller: Readonly<Caller>, imp: Imp | Promise<Imp>): Promise<Imp> => {
    const [shown] = await toCallerImps(caller, [await imp]);

    if (shown === undefined) {
      throw new Error('an imp went missing on its way out');
    }

    return shown;
  };

  const requireBackups = (): BackupService => {
    if (deps.backups === null) {
      throw buildBackupsOffError();
    }

    return deps.backups;
  };

  return os.router({
    imps: {
      // a network reaches past a caller's imp patterns, as a join does
      create: os.imps.create.handler(async (context) => {
        const caller = context.context.caller;
        const { networks, backup, ...input } = context.input;

        if (networks !== undefined && caller.imps !== null) {
          throw buildForbiddenError(
            `${formatCaller(caller)} is limited to some imps, so it cannot put an imp on a network`,
          );
        }

        // a template holds its source imp's disk: a caller limited to some
        // imps must reach the source, as for a fork
        if (caller.imps !== null) {
          const image = await deps.images.resolveImage(input.image);

          if (image.sourceImp !== null && !isCallerAllowed(caller, 'manage', image.sourceImp)) {
            throw buildForbiddenError(
              `${formatCaller(caller)} may not copy imp ${image.sourceImp}, the source of template ${image.name}`,
            );
          }
        }

        const networkIds = await deps.networks.resolveNetworkIds(networks ?? []);

        return toCallerImp(
          caller,
          deps.imps.createImp({ ...input, networkIds, isBackedUp: backup }),
        );
      }),
      list: os.imps.list.handler(async (context) => {
        const caller = context.context.caller;
        const builders = context.input?.builders === true;

        const imps = await listCallerImps(caller);

        return toCallerImps(
          caller,
          imps.filter((imp) => builders || imp.kind !== 'builder'),
        );
      }),
      get: os.imps.get.handler((context) =>
        toCallerImp(context.context.caller, deps.imps.getImp(context.input.name)),
      ),
      destroy: os.imps.destroy.handler(async (context) => {
        await deps.imps.destroyImp(context.input.name);

        return {};
      }),
      start: os.imps.start.handler((context) =>
        toCallerImp(context.context.caller, deps.imps.startImp(context.input.name)),
      ),
      stop: os.imps.stop.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.imps.stopImp(context.input.name, context.input.force ?? false),
        ),
      ),
      sleep: os.imps.sleep.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.imps.sleepImp(context.input.name, context.input.force ?? false),
        ),
      ),
      wake: os.imps.wake.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.imps.wakeImp(context.input.name, context.input.restartError),
        ),
      ),
      hold: os.imps.hold.handler((context) => {
        const caller = context.context.caller;

        return toCallerImp(
          caller,
          deps.imps.holdImp(context.input.name, context.input.seconds, requireLeaseHolder(caller)),
        );
      }),
      resizeDisk: os.imps.resizeDisk.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.imps.resizeDisk(context.input.name, context.input.diskMib),
        ),
      ),
      update: os.imps.update.handler((context) =>
        toCallerImp(context.context.caller, deps.imps.updateImp(context.input.name, context.input)),
      ),
      url: os.imps.url.handler((context) => deps.imps.readUrls(context.input.name)),
      policy: os.imps.policy.handler((context) => deps.egress.readPolicy(context.input.name)),
      setPolicy: os.imps.setPolicy.handler((context) =>
        deps.egress.setPolicy(context.input.name, context.input.policy),
      ),

      expose: os.imps.expose.handler((context) => exposure.expose(context.input)),
      unexpose: os.imps.unexpose.handler(async (context) => {
        await exposure.unexpose(context.input.name);

        return toCallerImp(context.context.caller, deps.imps.getImp(context.input.name));
      }),

      // a fork gets its source's grants the caller could make, as it gets
      // its disk; the answer names the rest
      fork: os.imps.fork.handler(async (context) => {
        const caller = context.context.caller;

        const forked = await deps.checkpoints.forkImp(context.input);

        const copied = await deps.broker.createForkGrants(
          { id: forked.sourceId, name: context.input.source },
          forked.imp,
          findForkAuthority(caller),
        );

        return {
          ...(await toCallerImp(caller, forked.imp)),
          grantsNotCopied: copied.notCopied,
          ...(copied.error !== null && { grantsError: copied.error }),
        };
      }),
    },
    leases: {
      acquire: os.leases.acquire.handler(async (context) => {
        const input = context.input;
        const caller = context.context.caller;

        const acquired = await deps.imps.acquireLease(
          input.name,
          requireLeaseHolder(caller),
          input.label,
          input.ttlSeconds,
        );

        return toApiLease(acquired.name, acquired.lease);
      }),
      renew: os.leases.renew.handler(async (context) => {
        const input = context.input;
        const caller = context.context.caller;

        const renewed = await deps.imps.renewLease(
          input.name,
          requireLeaseHolder(caller),
          input.label,
          input.ttlSeconds,
        );

        return toApiLease(renewed.name, renewed.lease);
      }),
      release: os.leases.release.handler(async (context) => {
        const input = context.input;
        const caller = context.context.caller;
        const holder = requireLeaseHolder(caller);

        const released = await deps.imps.releaseLease(input.name, holder, input.label);

        return { released };
      }),

      // the caller's imps only, and on them the leases it may see
      list: os.leases.list.handler(async (context) => {
        const caller = context.context.caller;
        const name = context.input.name;
        const label = context.input.label;

        requireNamedImp(caller, name, 'exec');

        if (name !== undefined) {
          await deps.imps.getImp(name);
        }

        const leases = await deps.imps.listLeases();

        return leases
          .filter(
            (each) =>
              (name === undefined || each.name === name) &&
              (label === undefined || each.lease.label === label) &&
              isCallerAllowed(caller, 'exec', each.name) &&
              isLeaseVisible(caller, each.lease),
          )
          .map((each) => toApiLease(each.name, each.lease));
      }),
    },
    checkpoints: {
      create: os.checkpoints.create.handler((context) =>
        deps.checkpoints.createCheckpoint(context.input.name, context.input.label),
      ),
      list: os.checkpoints.list.handler((context) =>
        deps.checkpoints.listCheckpoints(context.input.name),
      ),
      restore: os.checkpoints.restore.handler((context) =>
        toCallerImp(
          context.context.caller,
          deps.checkpoints.restoreCheckpoint(context.input.name, context.input.checkpoint),
        ),
      ),
      delete: os.checkpoints.delete.handler(async (context) => {
        await deps.checkpoints.deleteCheckpoint(context.input.name, context.input.checkpoint);

        return {};
      }),
    },
    moves: {
      prepare: os.moves.prepare.handler((context) =>
        deps.moves.prepare(context.input.name, {
          stop: context.input.stop === true,
          force: context.input.force === true,
          targetStorage: context.input.targetStorage ?? 'xfs',
          target: context.input.target ?? null,
        }),
      ),
      facts: os.moves.facts.handler(() => deps.moves.readFacts()),
      receive: os.moves.receive.handler((context) =>
        deps.moves.issueTicket(context.input.name, context.input.bytes, context.input.warm),
      ),
      send: os.moves.send.handler((context) =>
        deps.moves.send(context.input.name, context.input.to, context.input.ticket),
      ),
      status: os.moves.status.handler((context) => deps.moves.readStatus(context.input.name)),
      reissue: os.moves.reissue.handler((context) => deps.moves.reissueTicket(context.input.name)),
      resume: os.moves.resume.handler((context) =>
        deps.moves.resume(context.input.name, context.input.ticket),
      ),
      abort: os.moves.abort.handler((context) => deps.moves.abort(context.input.name)),
    },
    backups: {
      run: os.backups.run.handler(() => requireBackups().runBackup()),
      list: os.backups.list.handler(() => requireBackups().readStatus()),
      restore: os.backups.restore.handler((context) =>
        requireBackups().restoreBackup(context.input),
      ),
      check: os.backups.check.handler(async (context) => {
        await requireBackups().checkBackups(context.input.subset);

        return {};
      }),
    },
    images: buildImageRoutes(os, deps),
    exec: {
      // NOT_FOUND now, rather than at the socket's start
      ticket: os.exec.ticket.handler(async (context) => {
        await deps.imps.getImp(context.input.name);

        return deps.execTickets.issue(context.input.name, context.context.caller);
      }),
    },
    sessions: {
      list: os.sessions.list.handler((context) => deps.imps.listSessions(context.input.name)),
      kill: os.sessions.kill.handler(async (context) => {
        await deps.imps.killSession(context.input.name, context.input.session);

        return {};
      }),
      logs: os.sessions.logs.handler((context) =>
        deps.imps.listSessionLogs(context.input.name, context.input.session),
      ),
      readLog: os.sessions.readLog.handler((context) => {
        const { name, ...request } = context.input;

        return deps.imps.readSessionLog(name, request);
      }),
      deleteLog: os.sessions.deleteLog.handler(async (context) => {
        const { name, ...target } = context.input;

        return { deleted: await deps.imps.deleteSessionLogs(name, target) };
      }),
    },
    services: {
      list: os.services.list.handler((context) => deps.imps.listServices(context.input.name)),
      add: os.services.add.handler(async (context) => {
        const input = context.input;

        await deps.imps.addService(input.name, input.service, {
          canManage: hasScope(context.context.caller.scope, 'manage'),
          replace: input.replace ?? false,
        });

        return {};
      }),
      remove: os.services.remove.handler(async (context) => {
        const rights = { canManage: hasScope(context.context.caller.scope, 'manage') };

        await deps.imps.removeService(context.input.name, context.input.service, rights);

        return {};
      }),
      restart: os.services.restart.handler(async (context) => {
        const rights = { canManage: hasScope(context.context.caller.scope, 'manage') };

        await deps.imps.restartService(context.input.name, context.input.service, rights);

        return {};
      }),
      logs: os.services.logs.handler((context) =>
        deps.imps.openServiceLogs(context.input.name, {
          service: context.input.service,
          lines: context.input.lines ?? DEFAULT_LOG_LINES,
          follow: context.input.follow ?? false,
        }),
      ),
    },
    files: {
      write: os.files.write.handler((context) =>
        deps.imps.writeFile(context.input.name, context.input.path, context.input.content),
      ),
      remove: os.files.remove.handler((context) =>
        deps.imps.removeFile(context.input.name, context.input.path),
      ),
    },
    secrets: buildSecretRoutes(os, deps),
    networks: buildNetworkRoutes(os, deps),
    grants: buildGrantRoutes(os, deps),
    audit: buildAuditRoutes(os, deps),
    events: {
      // a dashboard's stream ends when its session expires or at a logout;
      // any stream ends when its token is removed
      stream: os.events.stream.handler((options) => {
        const caller = options.context.caller;

        return openEventStream({
          bus: deps.imps.events,
          readSnapshot: async () => {
            const snapshot = await readSnapshot(caller);

            return snapshot.filter((event) => isEventValid(event));
          },
          signal: mergeSignals(options.signal, options.context.ends),
          endsAt: caller.expiresAt,
          now: deps.now,
          accepts: (event) =>
            isEventValid(event) && isImpAllowed(caller.imps, readEventImpName(event)),
        });
      }),
    },
    system: buildSystemRoutes(os, deps),
    oauth: buildOAuthRoutes(os, deps),
    tokens: buildTokenRoutes(os, deps),
  });
}

function readEventImpName(event: ImpEvent): string {
  return 'imp' in event ? event.imp.name : event.name;
}
