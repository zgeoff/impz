import type { Imp } from '@impz/api';
import type { ImpRecord } from '../../platform/db/imps';
import { createEventBus } from '../../platform/events/event-bus';
import type { EventBus } from '../../platform/events/event-bus';
import { startImpEventPublisher } from '../../platform/events/imp-event-publisher';
import type { ResourceDelta } from '../../platform/telemetry/resource-delta';
import { readSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import type { AgentWatchdog } from '../../vm/watchdog/agent-watchdog';
import { createFileApi } from '../files/file-api';
import type { FileApi } from '../files/file-api';
import { createServiceApi } from '../services/service-api';
import type { ServiceApi } from '../services/service-api';
import { countSessions } from '../sessions/count-sessions';
import { createSessionService } from '../sessions/session-service';
import type { SessionService } from '../sessions/session-service';
import { readBootStatus } from './boot-status';
import type { BootStatus } from './boot-status';
import type { ImpCommands } from './imp-commands';
import { createImpCommands } from './imp-commands';
import { createImpContext } from './imp-context';
import type { ImpClock, ImpDisk, ImpHost, ImpServiceDeps, ImpVms } from './imp-context';
import { createImpLeases } from './imp-leases';
import type { ImpLeases } from './imp-leases';
import { createImpLock } from './imp-lock';
import type { ImpLock, LockedImp } from './imp-lock';
import { createImpPresenter } from './imp-presenter';
import { createImpRuntime } from './imp-runtime';
import type { ImpRuntime } from './imp-runtime';
import { createImpVmOps } from './imp-vm-ops';
import type { ImpVmOps } from './imp-vm-ops';
import { KERNEL_OOPS_REASON } from './kernel-oops-watch';
import { readRunningImpUsage } from './read-running-imp-usage';

export type { ImpServiceDeps } from './imp-context';

type ResourceListener = (deltas: readonly ResourceDelta[]) => void;

export type ImpService = ImpCommands &
  ImpLeases &
  SessionService &
  ServiceApi &
  FileApi &
  Pick<
    ImpRuntime,
    | 'openExec'
    | 'openBuilderExec'
    | 'openAttach'
    | 'openDial'
    | 'openListener'
    | 'openAccept'
    | 'recordActivity'
  > & {
    readonly countSessions: (imp: ImpRecord) => number | undefined;
    readonly readBootStatus: (imp: ImpRecord) => BootStatus;

    readonly isUnmergeable: (id: string) => boolean;

    readonly events: EventBus;

    readonly sampleResources: () => Promise<void>;
    readonly subscribeResources: (listener: ResourceListener) => () => void;
    readonly readCpuHost: () => { readonly hostCpus: number; readonly limitsEnforced: boolean };

    readonly readRebootReason: () => string | null;
  };

export interface ImpCheckpointHooks {
  readonly createImp: ImpCommands['createImp'];

  readonly destroyImpId: ImpCommands['destroyImpId'];
  readonly lockImp: <T>(name: string, action: (imp: LockedImp) => Promise<T>) => Promise<T>;

  readonly lockImpId: <T>(
    id: string,
    action: (imp: LockedImp | undefined) => Promise<T>,
  ) => Promise<T>;

  readonly haltImp: (imp: LockedImp, graceful?: boolean) => Promise<LockedImp>;

  readonly bootImp: (imp: LockedImp) => Promise<LockedImp>;

  readonly requireRunningImp: (imp: LockedImp) => Promise<LockedImp>;
  readonly toApi: (imp: ImpRecord) => Promise<Imp>;
}

export type Imps = ImpService &
  ImpRuntime &
  ImpCheckpointHooks & {
    readonly watchdog: AgentWatchdog;
  };

export type CreateImpWatchdog = (
  context: ImpHost & ImpClock & ImpVms & ImpDisk,
  lock: ImpLock,
  ops: ImpVmOps,
) => AgentWatchdog;

export function createImpService(deps: ImpServiceDeps, createWatchdog: CreateImpWatchdog): Imps {
  const context = createImpContext(deps);
  const lock = createImpLock(context);
  const ops = createImpVmOps(context);
  const watchdog = createWatchdog(context, lock, ops);
  const presenter = createImpPresenter(context, watchdog.readSilentSince);
  const events = deps.events ?? createEventBus();

  startImpEventPublisher({
    db: context.db,
    bus: events,
    toApi: presenter.readApi,
    now: context.now,
    log: context.log,
  });

  const resourceListeners = new Set<ResourceListener>();

  const leases = createImpLeases({ context, lock, ops, presenter });
  const commands = createImpCommands({ context, lock, ops, presenter, leases });
  const runtime = createImpRuntime({ context, lock, ops });

  const sessions = createSessionService({
    context,
    lock,
    requireRunning: runtime.requireRunning,
  });

  return {
    ...commands,
    ...leases,
    ...runtime,
    ...sessions,
    ...createServiceApi({
      runtime,
      events,
      readSleptServices: (imp) => readSnapshotMeta(context.findPaths(imp.id))?.services,
    }),
    ...createFileApi({ runtime }),
    countSessions: (imp) => countSessions(context, imp),
    readBootStatus: (imp) => readBootStatus(imp, context.findPaths(imp.id), context.identity),
    isUnmergeable: (id) => context.mergeFlags.isLost(id),
    lockImp: lock.withImp,
    lockImpId: (id, action) => lock.withImpId(id, action, { isMove: true }),
    haltImp: ops.stopImpVm,
    bootImp: (imp) => ops.startImpVm(imp, 'restore'),
    requireRunningImp: ops.requireRunningImp,
    toApi: presenter.readApi,
    events,
    sampleResources: async () => {
      const deltas = await readRunningImpUsage(context);

      for (const listener of resourceListeners) {
        listener(deltas);
      }
    },
    readCpuHost: () => ({
      hostCpus: context.hostCpus,
      limitsEnforced: context.cgroups.isEnforced,
    }),
    readRebootReason: () => (context.kernelOops.isOopsed() ? KERNEL_OOPS_REASON : null),
    subscribeResources: (listener) => {
      resourceListeners.add(listener);

      return () => {
        resourceListeners.delete(listener);
      };
    },
    watchdog,
  };
}
