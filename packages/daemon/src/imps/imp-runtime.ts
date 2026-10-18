import { ORPCError } from '@orpc/server';
import type { AgentFeature } from '../agent-client/agent-outdated';
import type { Activity, InnerStatus } from '../agent-client/agent-protocol';
import { sendActivity, sendPing } from '../agent-client/agent-requests';
import { openDialStream } from '../agent-client/dial-stream';
import type { DialStream, DialTarget } from '../agent-client/dial-stream';
import { openAttachStream, openExecStream } from '../agent-client/exec-stream';
import type { AgentAttachRequest, AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { openAccept, openListener } from '../agent-client/listener-stream';
import type { GuestListener, ListenSpec } from '../agent-client/listener-stream';
import {
  buildBuilderError,
  buildInvalidStateError,
  isDiskFullError,
  isMovingError,
} from '../api-errors';
import { listColdBoots } from '../db/cold-boots';
import { findImpById, findImpByName, listImps, updateImpActivity } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import { findSessionLogImp } from '../session-logs/find-session-log-imp';
import { toSeenSessions } from '../sessions/session-cache';
import type { ImpPaths } from '../storage/data-layout';
import type { BootTemplates } from '../templates/boot-templates';
import type { ActivityTracker, ConnectionKind } from './activity-tracker';
import type { ImpClock, ImpGuest, ImpHost, ImpMemory, ImpVms } from './imp-context';
import type { ImpLock, LockedImp } from './imp-lock';
import type { ImpVmOps } from './imp-vm-ops';
import { createLockFreeSleep } from './lock-free-sleep';
import type { LockFreeSleep, SleepOutcome, SleepPolicy } from './lock-free-sleep';
import { makeReconcileImps } from './make-reconcile-imps';
import type { YoungGuestWait } from './make-sleep-imp-vm';
import { openImpExec } from './open-imp-exec';
import { requireFeature } from './require-feature';
import { withColdBoots } from './with-cold-boots';

// What the wake proxy, the idle loop, the governor and impd's start and stop
// need: imps woken on demand, put to sleep in the background, and the
// connections that keep them awake.
export interface ImpRuntime {
  // the imp must be running; exec runs outside the lifecycle lock (one that
  // requires the broker holds it only until the start), so a console never
  // blocks stop. `feature`: AGENT_OUTDATED when the agent is older than it.
  readonly openExec: (
    name: string,
    request: AgentExecRequest,
    feature?: AgentFeature,
  ) => Promise<ExecStream>;

  // as openExec, for an image build's own steps in its builder, which every
  // other stream and wake is refused (docs/guides/images.md#isolated-builds)
  readonly openBuilderExec: (name: string, request: AgentExecRequest) => Promise<ExecStream>;

  // as openExec, for a session that exists; with `wake: false`, an imp that
  // is not running fails with INVALID_STATE and nothing boots
  readonly openAttach: (name: string, request: AgentAttachRequest) => Promise<ExecStream>;

  // as openExec, for a connection to an address inside the guest; `kind` is
  // what it counts as while open: an SSH forward or an `impz proxy` tunnel
  readonly openDial: (
    name: string,
    target: DialTarget,
    kind: Extract<ConnectionKind, 'ssh' | 'tunnel'>,
  ) => Promise<DialStream>;

  // as openExec, for ssh-agent forwarding and reverse forwards: a socket in
  // the guest, and the relay for each client. A null `kind` counts for
  // nothing: a reverse forward alone does not keep the imp awake.
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

  // as openExec, for any other agent connection: `open` gets the vsock
  // socket once the imp runs, and the connection counts as an exec until
  // its `close`; `feature` as for openExec
  readonly openAgentStream: <T extends { readonly close: () => void }>(
    name: string,
    open: (vsockPath: string) => Promise<T>,
    feature?: AgentFeature,
  ) => Promise<T>;

  // for a watcher that must not wake the imp or keep it awake: the imp as
  // it is, and its agent's vsock socket when it runs; `feature` as for
  // openExec, checked only then
  readonly findAgent: (
    name: string,
    feature?: AgentFeature,
  ) => Promise<{ readonly imp: ImpRecord; readonly vsockPath: string | null }>;

  // as openAgentStream, for one request: it counts as an exec until `send`
  // settles
  readonly sendToAgent: <T>(
    name: string,
    send: (vsockPath: string) => Promise<T>,
    feature?: AgentFeature,
  ) => Promise<T>;

  // for the idle loop: the agent's activity, its sessions recorded on the
  // way; null when the agent does not answer
  readonly readActivity: (imp: ImpRecord) => Promise<Activity | null>;

  // for the wake proxy: the running imp, woken or booted first if needed;
  // `wokeMs` is null when it already ran. `onFound` runs before any wait, so
  // the caller can count its connection before the idle loop looks again.
  readonly requireRunning: (
    name: string,
    onFound?: (imp: ImpRecord) => void,
  ) => Promise<{ readonly imp: ImpRecord; readonly wokeMs: number | null }>;

  // for the idle loop and the governor: sleeps the imp if it still runs and
  // `policy` still allows it
  readonly trySleepImp: LockFreeSleep;

  // on SIGTERM: every running imp to sleep, a few at a time. A wake or boot
  // already under way finishes first and is put to sleep; later ones fail.
  readonly sleepAllImps: () => Promise<void>;

  // ends the session logs of VMs that are gone and removes those past their
  // age (docs/architecture/guest/sessions.md#session-logs)
  readonly sweepSessionLogs: () => Promise<void>;

  // on SIGHUP: impd restarts in place and leaves VMs running, but a wake or
  // boot under way must finish, or its Firecracker has no record
  readonly waitForLifecycle: () => Promise<void>;

  // after an impd start: re-adopt live VMs, mark the rest stopped; sleeping
  // imps stay asleep until something needs them
  readonly reconcileImps: () => Promise<void>;
  readonly isImpBusy: (id: string) => boolean;

  // the lifecycle operations that run or wait on the imp's lock
  readonly countLockQueue: (id: string) => number;

  // true from a background sleep's first check that it is still wanted (made
  // once its guest proved young) until that sleep returns, so it also covers
  // the pause and the snapshot after the young-guest wait
  readonly isWaitingForYoungGuest: (id: string) => boolean;

  // for the memory controller: runs `action` under the imp's lock when the
  // lock is free and the imp still runs; false when it did not run
  readonly tryWhileRunning: (id: string, action: () => Promise<void>) => Promise<boolean>;
  readonly tracker: ActivityTracker;

  // the boot templates cold boots restore; null when IMP_BOOT_TEMPLATES is off
  readonly bootTemplates: BootTemplates | null;

  // the DISK_FULL that last turned a background sleep away
  readonly readDiskFullError: () => Error | null;
}

interface ImpRuntimeParts {
  readonly context: ImpHost & ImpClock & ImpVms & ImpMemory & ImpGuest;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
}

// the idle loop's ping beside its activity call, as short as that call's
const INNER_PING_TIMEOUT_MS = 1000;

export function createImpRuntime(parts: ImpRuntimeParts): ImpRuntime {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const lastDiskFull: { error: Error | null } = { error: null };

  // imps whose background sleep found a young guest and waits for it; each
  // leaves once its sleep ends
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

    // the hot path: no lock while nothing else changes the imp
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

  // as requireRunning, for a caller that must not boot or wake the imp: one
  // that is not running fails with INVALID_STATE and its cold boots
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
        throw await buildNotAwakeError(context, imp);
      }

      onFound?.(imp);

      return { imp, wokeMs: null };
    });
  };

  // A sleeping imp wakes and a stopped one boots, as for an HTTP request.
  // The stream counts from the moment the imp is found, before any wake, so
  // no background sleep slips in between the wake and the open.
  const openStream = async <T extends { readonly close: () => void }>(
    name: string,
    kind: ConnectionKind | null,
    open: (paths: ImpPaths, imp: ImpRecord) => Promise<T>,
    wake = true,
    isBuilderAllowed = false,
  ): Promise<T> => {
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

      const stream = await open(context.findPaths(imp.id), imp);

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

  // a builder sleeps through nothing: its build would stall until a wake
  const isSleepAllowed = (imp: ImpRecord, policy: SleepPolicy): boolean => {
    if (imp.kind === 'builder' || context.tracker.count(imp.id) > 0) {
      return false;
    }

    if (imp.holdUntil !== null && imp.holdUntil.getTime() > context.now()) {
      return false;
    }

    return policy.by === 'governor' || imp.lastActiveAt.getTime() <= policy.seenActiveAt;
  };

  // The governor sleeps at once: it holds admission, and the boot waiting on
  // it matters more than a slow wake later. Other sleeps wait for a young
  // guest, and give way if the imp turns busy or is held meanwhile.
  const buildYoungGuestWait = (id: string, policy: SleepPolicy): YoungGuestWait => {
    if (policy.by === 'governor') {
      return { wait: false };
    }

    // the wait asks only once the guest proved young
    const isWanted = async (): Promise<boolean> => {
      youngGuestWaits.add(id);

      const fresh = await findImpById(context.db, id);

      return fresh !== undefined && isSleepAllowed(fresh, policy);
    };

    return { wait: true, isWanted };
  };

  // the caller holds the lock; a failure leaves the imp as sleepImpVm left it
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
      // the disk budget logs a low disk once for the whole disk
      if (isDiskFullError(error)) {
        lastDiskFull.error = error;

        return 'diskFull';
      }

      context.log(`impd: ${imp.name}: could not sleep: ${readErrorMessage(error)}`);

      return 'failed';
    } finally {
      youngGuestWaits.delete(imp.id);
    }
  };

  return {
    openExec: (name, request, feature) =>
      openStream(name, 'exec', (paths, imp) =>
        openImpExec(parts, name, request, feature, paths, imp),
      ),
    openBuilderExec: (name, request) =>
      openStream(name, 'exec', (paths) => openExecStream(paths.vsockSocket, request), true, true),
    openAttach: (name, request) =>
      openStream(
        name,
        'exec',
        (paths, imp) => withColdBoots(context, imp, openAttachStream(paths.vsockSocket, request)),
        request.wake ?? true,
      ),
    openDial: (name, target, kind) =>
      openStream(name, kind, (paths) => {
        // an older agent dials a unix socket as root, past its mode
        const feature = target.network === 'unix' ? 'unix-dial-as-user' : 'ssh';

        requireFeature(paths, feature);

        return openDialStream(paths.vsockSocket, target);
      }),
    openListener: (name, spec, kind) =>
      openStream(name, kind, (paths) => {
        const feature = spec.network === 'ssh-agent' ? 'agent-forwarding' : 'reverse-forward';

        requireFeature(paths, feature);

        return openListener(paths.vsockSocket, spec);
      }),
    openAccept: (name, listener, connection, kind) =>
      openStream(name, kind, (paths) => openAccept(paths.vsockSocket, listener, connection)),

    readActivity: async (imp) => {
      const vsockPath = context.findPaths(imp.id).vsockSocket;

      try {
        // the ping for the inner container; an agent that answers the
        // activity but not it leaves the container unknown
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
      openStream(name, 'exec', (paths) => {
        if (feature !== undefined) {
          requireFeature(paths, feature);
        }

        return open(paths.vsockSocket);
      }),

    findAgent: async (name, feature) => {
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
      const sent = await openStream(name, 'exec', async (paths) => {
        if (feature !== undefined) {
          requireFeature(paths, feature);
        }

        const value = await send(paths.vsockSocket);

        return { value, close: () => {} };
      });

      sent.close();

      return sent.value;
    },

    recordActivity: async (name) => {
      const imp = await findImpByName(context.db, name);

      if (imp !== undefined) {
        await updateImpActivity(context.db, imp.id, new Date());
      }
    },

    requireRunning,

    trySleepImp: createLockFreeSleep<LockedImp | undefined>(
      lock.tryWithImpId,
      (imp, reason, policy) =>
        imp !== undefined && isSleepAllowed(imp, policy)
          ? sleepIfRunning(imp, reason, buildYoungGuestWait(imp.id, policy))
          : Promise.resolve<SleepOutcome>('skipped'),
    ),

    // open connections do not count: impd is going away
    sleepAllImps: async () => {
      ops.stopVmStarts();

      // every imp, not only the running ones: a sleeping or stopped imp may be
      // waking or booting under its lock right now
      const imps = await listImps(context.db);

      // a moving imp never runs: its move halted it before the mark
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

// INVALID_STATE for an attach that must not wake the imp; an imp still
// being created has no boots to name
async function buildNotAwakeError(context: ImpHost, imp: ImpRecord): Promise<Error> {
  const error = buildInvalidStateError(imp.state, ['running'], 'attach without a wake to');

  if (imp.state === 'creating') {
    return error;
  }

  const coldBoots = await listColdBoots(context.db, imp.id);

  return new ORPCError('INVALID_STATE', {
    status: error.status,
    message: error.message,
    data: { ...error.data, coldBoots },
  });
}

// an agent from before 0.14.0 reports no inner container
function updateInner(context: ImpGuest, impId: string, inner: InnerStatus | undefined): void {
  if (inner === undefined) {
    context.inners.forget(impId);

    return;
  }

  context.inners.record(impId, inner);
}
