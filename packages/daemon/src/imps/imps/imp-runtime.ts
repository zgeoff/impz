import type { Activity, InnerStatus } from '@impz/agent-protocol';
import { listColdBoots } from '../../platform/db/cold-boots';
import { listImps, readImpById, readImpByName, updateImpActivity } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { ImpdError } from '../../platform/errors/impd-error';
import {
  buildBuilderError,
  buildInvalidStateError,
  isMovingError,
} from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import type { AgentFeature } from '../../vm/agent-client/agent-outdated';
import { sendActivity, sendPing } from '../../vm/agent-client/agent-requests';
import { openDialStream } from '../../vm/agent-client/dial-stream';
import type { DialStream, DialTarget } from '../../vm/agent-client/dial-stream';
import { openAttachStream, openExecStream } from '../../vm/agent-client/exec-stream';
import type {
  AgentAttachRequest,
  AgentExecRequest,
  ExecStream,
} from '../../vm/agent-client/exec-stream';
import { openAccept, openListener } from '../../vm/agent-client/listener-stream';
import type { GuestListener, ListenSpec } from '../../vm/agent-client/listener-stream';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { isDiskFullError } from '../../vm/storage/disk-full-error';
import type { BootTemplates } from '../../vm/templates/boot-templates';
import { findSessionLogImp } from '../session-logs/find-session-log-imp';
import { toSeenSessions } from '../sessions/session-cache';
import type { ActivityTracker, ConnectionKind } from './activity-tracker';
import type { ImpClock, ImpGuest, ImpHost, ImpMemory, ImpVms } from './imp-context';
import type { ImpLock, LockedImp } from './imp-lock';
import type { ImpVmOps } from './imp-vm-ops';
import { makeLockFreeSleep } from './lock-free-sleep';
import type { LockFreeSleep, SleepOutcome, SleepPolicy } from './lock-free-sleep';
import { makeReconcileImps } from './make-reconcile-imps';
import type { YoungGuestWait } from './make-sleep-imp-vm';
import { openImpExec } from './open-imp-exec';
import { requireFeature } from './require-feature';
import { withColdBoots } from './with-cold-boots';

export interface ImpRuntime {
  readonly openExec: (
    name: string,
    request: AgentExecRequest,
    feature?: AgentFeature,
  ) => Promise<ExecStream>;

  readonly openBuilderExec: (name: string, request: AgentExecRequest) => Promise<ExecStream>;

  readonly openAttach: (name: string, request: AgentAttachRequest) => Promise<ExecStream>;

  readonly openDial: (
    name: string,
    target: DialTarget,
    kind: Extract<ConnectionKind, 'ssh' | 'tunnel'>,
  ) => Promise<DialStream>;

  readonly openListener: (
    name: string,
    spec: ListenSpec,
    kind: Extract<ConnectionKind, 'ssh'> | null,
  ) => Promise<GuestListener>;
  readonly openAccept: (
    name: string,
    listener: string,
    connection: number,
    kind: Extract<ConnectionKind, 'ssh' | 'tunnel'>,
  ) => Promise<DialStream>;
  readonly recordActivity: (name: string) => Promise<void>;

  readonly openAgentStream: <T extends { readonly close: () => void }>(
    name: string,
    open: (vsockPath: string) => Promise<T>,
    feature?: AgentFeature,
  ) => Promise<T>;

  readonly readAgent: (
    name: string,
    feature?: AgentFeature,
  ) => Promise<{ readonly imp: ImpRecord; readonly vsockPath: string | null }>;

  readonly sendToAgent: <T>(
    name: string,
    send: (vsockPath: string) => Promise<T>,
    feature?: AgentFeature,
  ) => Promise<T>;

  readonly readActivity: (imp: ImpRecord) => Promise<Activity | null>;

  readonly requireRunning: (
    name: string,
    onFound?: (imp: ImpRecord) => void,
  ) => Promise<{ readonly imp: ImpRecord; readonly wokeMs: number | null }>;

  readonly trySleepImp: LockFreeSleep;

  readonly sleepAllImps: () => Promise<void>;

  readonly sweepSessionLogs: () => Promise<void>;

  // impd restarts in place on SIGHUP and leaves VMs running, so a wake or boot
  // under way must finish first, or its Firecracker has no record.
  readonly waitForLifecycle: () => Promise<void>;

  readonly reconcileImps: () => Promise<void>;
  readonly isImpBusy: (id: string) => boolean;

  readonly countLockQueue: (id: string) => number;

  readonly isWaitingForYoungGuest: (id: string) => boolean;

  readonly tryWhileRunning: (id: string, action: () => Promise<void>) => Promise<boolean>;
  readonly tracker: ActivityTracker;

  readonly bootTemplates: BootTemplates | null;

  readonly readDiskFullError: () => Error | null;
}

interface ImpRuntimeParts {
  readonly context: ImpHost & ImpClock & ImpVms & ImpMemory & ImpGuest;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
}

const INNER_PING_TIMEOUT_MS = 1000;

interface OpenStreamOptions<T extends { readonly close: () => void }> {
  readonly name: string;
  readonly kind: ConnectionKind | null;
  readonly open: (paths: ImpPaths, imp: ImpRecord) => Promise<T>;
  readonly wake?: boolean;
  readonly isBuilderAllowed?: boolean;
}

export function createImpRuntime(parts: ImpRuntimeParts): ImpRuntime {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const lastDiskFull: { error: Error | null } = { error: null };

  const youngGuestWaits = new Set<string>();

  const requireRunningImp = async (
    name: string,
    onFound: ((imp: ImpRecord) => void) | undefined,
    isBuilderAllowed: boolean,
  ) => {
    const found = await lock.findImp(name);

    if (found.kind === 'builder' && !isBuilderAllowed) {
      throw buildBuilderError(found.name);
    }

    onFound?.(found);

    if (found.state === 'running' && !lock.isLocked(found.id)) {
      return { imp: found, wokeMs: null };
    }

    const started = performance.now();

    return lock.withImp(name, async (imp) => {
      if (imp.state === 'running') {
        return { imp, wokeMs: null };
      }

      const running = await ops.requireRunningImp(imp);

      return { imp: running, wokeMs: Math.round(performance.now() - started) };
    });
  };

  const requireRunning: ImpRuntime['requireRunning'] = (name, onFound) =>
    requireRunningImp(name, onFound, false);

  const requireAwake: ImpRuntime['requireRunning'] = async (name, onFound) => {
    const found = await lock.findImp(name);

    if (found.kind === 'builder') {
      throw buildBuilderError(found.name);
    }

    if (found.state === 'running' && !lock.isLocked(found.id)) {
      onFound?.(found);

      return { imp: found, wokeMs: null };
    }

    return lock.withImp(name, async (imp) => {
      if (imp.state !== 'running') {
        throw await readNotAwakeError(context, imp);
      }

      onFound?.(imp);

      return { imp, wokeMs: null };
    });
  };

  const openStream = async <T extends { readonly close: () => void }>(
    options: OpenStreamOptions<T>,
  ): Promise<T> => {
    const name = options.name;
    const kind = options.kind;
    const wake = options.wake ?? true;
    const isBuilderAllowed = options.isBuilderAllowed ?? false;
    const opened = { release: () => {} };

    const onFound = (found: ImpRecord) => {
      if (kind !== null) {
        opened.release = context.tracker.open(found.id, kind);
      }
    };

    try {
      const running = wake
        ? await requireRunningImp(name, onFound, isBuilderAllowed)
        : await requireAwake(name, onFound);

      const imp = running.imp;

      await updateImpActivity(context.db, imp.id, new Date());

      const stream = await options.open(context.findPaths(imp.id), imp);

      return {
        ...stream,
        close: () => {
          opened.release();
          stream.close();
        },
      };
    } catch (error) {
      opened.release();
      throw error;
    }
  };

  const isSleepAllowed = (imp: ImpRecord, policy: SleepPolicy): boolean => {
    if (imp.kind === 'builder' || context.tracker.count(imp.id) > 0) {
      return false;
    }

    if (imp.holdUntil !== null && imp.holdUntil.getTime() > context.now()) {
      return false;
    }

    return policy.by === 'governor' || imp.lastActiveAt.getTime() <= policy.seenActiveAt;
  };

  const buildYoungGuestWait = (id: string, policy: SleepPolicy): YoungGuestWait => {
    if (policy.by === 'governor') {
      return { wait: false };
    }

    const probeWanted = async (): Promise<boolean> => {
      youngGuestWaits.add(id);

      const fresh = await readImpById(context.db, id);

      return fresh !== undefined && isSleepAllowed(fresh, policy);
    };

    return { wait: true, isWanted: probeWanted };
  };

  const sleepIfRunning = async (
    imp: LockedImp | undefined,
    reason: string,
    youngGuest?: YoungGuestWait,
  ): Promise<SleepOutcome> => {
    if (imp?.state !== 'running') {
      return 'skipped';
    }

    try {
      const after = await ops.sleepImpVm(imp, reason, youngGuest);

      return after.state === 'sleeping' ? 'slept' : 'skipped';
    } catch (error) {
      if (isDiskFullError(error)) {
        lastDiskFull.error = error;

        return 'diskFull';
      }

      context.log(`impd: ${imp.name}: could not sleep: ${getErrorMessage(error)}`);

      return 'failed';
    } finally {
      youngGuestWaits.delete(imp.id);
    }
  };

  return {
    openExec: (name, request, feature) =>
      openStream({
        name,
        kind: 'exec',
        open: (paths, imp) => openImpExec(parts, { name, request, feature, paths, imp }),
      }),
    openBuilderExec: (name, request) =>
      openStream({
        name,
        kind: 'exec',
        open: (paths) => openExecStream(paths.vsockSocket, request),
        wake: true,
        isBuilderAllowed: true,
      }),
    openAttach: (name, request) =>
      openStream({
        name,
        kind: 'exec',
        open: (paths, imp) =>
          withColdBoots(context, imp, openAttachStream(paths.vsockSocket, request)),
        wake: request.wake ?? true,
      }),
    openDial: (name, target, kind) =>
      openStream({
        name,
        kind,
        open: (paths) => {
          // An older agent dials a unix socket as root, past the socket's mode.
          const feature = target.network === 'unix' ? 'unix-dial-as-user' : 'ssh';

          requireFeature(paths, feature);

          return openDialStream(paths.vsockSocket, target);
        },
      }),
    openListener: (name, spec, kind) =>
      openStream({
        name,
        kind,
        open: (paths) => {
          const feature = spec.network === 'ssh-agent' ? 'agent-forwarding' : 'reverse-forward';

          requireFeature(paths, feature);

          return openListener(paths.vsockSocket, spec);
        },
      }),
    openAccept: (name, listener, connection, kind) =>
      openStream({
        name,
        kind,
        open: (paths) => openAccept(paths.vsockSocket, listener, connection),
      }),

    readActivity: async (imp) => {
      const vsockPath = context.findPaths(imp.id).vsockSocket;

      try {
        const [activity, ping] = await Promise.all([
          sendActivity(vsockPath),
          sendPing(vsockPath, INNER_PING_TIMEOUT_MS).catch(() => null),
        ]);

        context.sessions.record(imp.id, toSeenSessions(activity.sessions, new Date()));
        context.sessionLogs.observe(findSessionLogImp(context.findPaths, imp), activity.sessions);

        updateInner(context, imp.id, ping?.inner);

        return activity;
      } catch {
        context.inners.forget(imp.id);

        return null;
      }
    },

    openAgentStream: (name, open, feature) =>
      openStream({
        name,
        kind: 'exec',
        open: (paths) => {
          if (feature !== undefined) {
            requireFeature(paths, feature);
          }

          return open(paths.vsockSocket);
        },
      }),

    readAgent: async (name, feature) => {
      const imp = await lock.findImp(name);

      if (imp.kind === 'builder') {
        throw buildBuilderError(imp.name);
      }

      if (imp.state !== 'running' || lock.isLocked(imp.id)) {
        return { imp, vsockPath: null };
      }

      const paths = context.findPaths(imp.id);

      if (feature !== undefined) {
        requireFeature(paths, feature);
      }

      return { imp, vsockPath: paths.vsockSocket };
    },

    sendToAgent: async (name, send, feature) => {
      const sent = await openStream({
        name,
        kind: 'exec',
        open: async (paths) => {
          if (feature !== undefined) {
            requireFeature(paths, feature);
          }

          const value = await send(paths.vsockSocket);

          return { value, close: () => {} };
        },
      });

      sent.close();

      return sent.value;
    },

    recordActivity: async (name) => {
      const imp = await readImpByName(context.db, name);

      if (imp !== undefined) {
        await updateImpActivity(context.db, imp.id, new Date());
      }
    },

    requireRunning,

    trySleepImp: makeLockFreeSleep<LockedImp | undefined>(
      lock.tryWithImpId,
      (imp, reason, policy) =>
        imp !== undefined && isSleepAllowed(imp, policy)
          ? sleepIfRunning(imp, reason, buildYoungGuestWait(imp.id, policy))
          : Promise.resolve<SleepOutcome>('skipped'),
    ),

    sleepAllImps: async () => {
      ops.stopVmStarts();

      const imps = await listImps(context.db);

      await Promise.all(
        imps.map((imp) =>
          lock
            .withImpId(imp.id, (fresh) => sleepIfRunning(fresh, 'impd is stopping'))
            .catch((error: unknown) => {
              if (!isMovingError(error)) {
                throw error;
              }
            }),
        ),
      );
    },

    sweepSessionLogs: async () => {
      const imps = await listImps(context.db);

      await context.sessionLogs.sweep(imps.map((imp) => findSessionLogImp(context.findPaths, imp)));
    },

    reconcileImps: makeReconcileImps(parts),

    waitForLifecycle: () => lock.waitForAll(),
    isImpBusy: (id) => lock.isLocked(id),
    countLockQueue: (id) => lock.countQueued(id),
    isWaitingForYoungGuest: (id) => youngGuestWaits.has(id),

    tryWhileRunning: async (id, action) => {
      const result = await lock.tryWithImpId(id, async (imp) => {
        if (imp?.state !== 'running') {
          return false;
        }

        await action();

        return true;
      });

      return result.ran && result.value;
    },

    tracker: context.tracker,
    bootTemplates: context.templates,
    readDiskFullError: () => lastDiskFull.error,
  };
}

async function readNotAwakeError(context: ImpHost, imp: ImpRecord): Promise<Error> {
  const error = buildInvalidStateError(imp.state, ['running'], 'attach without a wake to');

  if (imp.state === 'creating') {
    return error;
  }

  const coldBoots = await listColdBoots(context.db, imp.id);

  return new ImpdError('INVALID_STATE', {
    status: error.status,
    message: error.message,
    data: { state: imp.state, allowed: ['running'], coldBoots },
  });
}

function updateInner(context: ImpGuest, impId: string, inner: InnerStatus | undefined): void {
  if (inner === undefined) {
    context.inners.forget(impId);

    return;
  }

  context.inners.record(impId, inner);
}
