import type { LogCursor, ServiceStatus, ServicesList } from '@impz/agent-protocol';
import { ServiceRestartSchema, ServiceStateSchema } from '@impz/api';
import type { Service, ServiceDef, ServiceList, ServiceLog } from '@impz/api';
import type { ImpRecord } from '../../../platform/db/imps';
import { ImpdError, isImpdError } from '../../../platform/errors/impd-error';
import {
  buildAgentOutdatedApiError,
  buildConflictError,
  buildForbiddenError,
  buildInvalidStateError,
  buildNotFoundError,
} from '../../../platform/errors/impd-errors';
import type { EventBus } from '../../../platform/events/event-bus';
import type { StartTimer } from '../../../platform/process/clock';
import { startRealTimer } from '../../../platform/process/start-real-timer';
import { isAgentError } from '../../../vm/agent-client/is-agent-error';
import {
  openServiceLogStream,
  sendServicesAdd,
  sendServicesList,
  sendServicesRemove,
  sendServicesRestart,
} from '../../../vm/agent-client/service-requests';
import { getSignalName } from '../../exec/signal-names';
import type { ImpRuntime } from '../imp-runtime';
import { createLogDecoders } from './create-log-decoders';
import { mergeLogStreams } from './merge-log-streams';
import type { NamedStream } from './merge-log-streams';
import { stopOnReturn } from './stop-on-return';
import { waitForImpChange } from './wait-for-imp-change';

interface ServiceRights {
  readonly canManage: boolean;
  readonly replace?: boolean;
}

interface ServiceLogsRequest {
  readonly service: string | undefined;
  readonly lines: number;
  readonly follow: boolean;
}

export interface ServiceApi {
  readonly listServices: (name: string) => Promise<ServiceList>;
  readonly addService: (
    name: string,
    def: Readonly<ServiceDef>,
    rights: ServiceRights,
  ) => Promise<void>;
  readonly removeService: (name: string, service: string, rights: ServiceRights) => Promise<void>;
  readonly restartService: (name: string, service: string, rights: ServiceRights) => Promise<void>;
  readonly openServiceLogs: (
    name: string,
    request: Readonly<ServiceLogsRequest>,
  ) => Promise<AsyncIteratorObject<ServiceLog, void, undefined>>;

  readonly endLogFollows: () => void;
}

interface ServiceApiParts {
  readonly runtime: Pick<ImpRuntime, 'sendToAgent' | 'openAgentStream' | 'readAgent'>;
  readonly events: Pick<EventBus, 'subscribe'>;

  readonly readSleptServices: (imp: ImpRecord) => ServicesList | undefined;

  readonly now?: () => number;
  readonly startTimer?: StartTimer;
}

interface WaitContext {
  readonly runtime: Pick<ImpRuntime, 'readAgent'>;
  readonly now: () => number;
  readonly startTimer: StartTimer;
}

interface FollowControl {
  readonly readStreams: () => readonly NamedStream[];
  readonly setStreams: (streams: readonly NamedStream[]) => void;
  readonly signal: Readonly<AbortSignal>;

  readonly stop: () => void;
}

interface FollowContext extends WaitContext {
  readonly events: Pick<EventBus, 'subscribe'>;
  readonly restart: { readonly started: boolean };
}

export function createServiceApi(parts: ServiceApiParts): ServiceApi {
  const runtime = parts.runtime;

  const follows = new Set<FollowControl>();

  const restart = { started: false };

  const followContext: FollowContext = {
    runtime,
    events: parts.events,
    restart,
    now: parts.now ?? Date.now,
    startTimer: parts.startTimer ?? startRealTimer,
  };

  const openLogs: ServiceApi['openServiceLogs'] = async (name, request) => {
    if (!request.follow) {
      const opened = await runtime
        .openAgentStream(
          name,
          async (vsockPath) => {
            const services = await listServiceNames(vsockPath, request);
            const streams = await openLogStreams(vsockPath, services, request, new Map());

            return {
              streams,
              close: () => {
                stopStreams(streams);
              },
            };
          },
          'services',
        )
        .catch(handleAgentError(request.service ?? ''));

      return stopOnReturn(readLogs(opened.streams), opened.close);
    }

    const found = await runtime.readAgent(name, 'services').catch(handleAgentError(''));

    const control = createFollowControl();

    if (found.vsockPath !== null) {
      const services = await listServiceNames(found.vsockPath, request).catch(handleAgentError(''));
      const streams = await openLogStreams(found.vsockPath, services, request, new Map());

      control.setStreams(streams);
    }

    follows.add(control);

    return stopOnReturn(readFollowedLogs(followContext, name, request, control), () => {
      follows.delete(control);
      control.stop();
    });
  };

  return {
    listServices: async (name) => {
      const found = await readRunningAgent(followContext, name);

      if (found.vsockPath === null) {
        const slept = parts.readSleptServices(found.imp);

        return {
          services: (slept?.services ?? []).map((service) => toApiService(service)),
          recorded: slept !== undefined,
        };
      }

      const listed = await sendServicesList(found.vsockPath).catch(handleAgentError(''));

      return { services: listed.services.map((service) => toApiService(service)), recorded: true };
    },

    addService: async (name, def, rights) => {
      await runtime
        .sendToAgent(
          name,
          async (vsockPath) => {
            if (!rights.canManage) {
              const listed = await sendServicesList(vsockPath);

              requireExecRights(listed, def, rights.replace === true);
            }

            await sendServicesAdd(
              vsockPath,
              {
                name: def.name,
                argv: [...def.argv],
                ...(def.env !== undefined && { env: [...def.env] }),
                ...(def.cwd !== undefined && { cwd: def.cwd }),
                ...(def.user !== undefined && { user: def.user }),
                ...(def.restart !== undefined && { restart: def.restart }),
              },
              rights.replace === true,
            );
          },
          'services',
        )
        .catch(handleAgentError(def.name));
    },

    removeService: async (name, service, rights) => {
      await runtime
        .sendToAgent(
          name,
          async (vsockPath) => {
            if (!rights.canManage) {
              const listed = await sendServicesList(vsockPath);

              requireNotRoot(listed, service, 'remove');
            }

            await sendServicesRemove(vsockPath, service);
          },
          'services',
        )
        .catch(handleAgentError(service));
    },

    restartService: async (name, service, rights) => {
      await runtime
        .sendToAgent(
          name,
          async (vsockPath) => {
            if (!rights.canManage) {
              const listed = await sendServicesList(vsockPath);

              requireNotRoot(listed, service, 'restart');
            }

            await sendServicesRestart(vsockPath, service);
          },
          'services',
        )
        .catch(handleAgentError(service));
    },

    openServiceLogs: openLogs,

    endLogFollows: () => {
      restart.started = true;

      for (const control of follows) {
        control.stop();
      }
    },
  };
}

async function listServiceNames(
  vsockPath: string,
  request: Readonly<ServiceLogsRequest>,
): Promise<string[]> {
  if (request.service !== undefined) {
    return [request.service];
  }

  const listed = await sendServicesList(vsockPath);

  return listed.services.map((entry) => entry.name);
}

async function openLogStreams(
  vsockPath: string,
  services: readonly string[],
  request: Readonly<ServiceLogsRequest>,
  cursors: ReadonlyMap<string, LogCursor>,
): Promise<NamedStream[]> {
  const lines = countLinesPerService(request, services.length);
  const streams: NamedStream[] = [];

  try {
    for (const service of services) {
      const stream = await openServiceLogStream(vsockPath, {
        service,
        lines,
        follow: request.follow,
        cursor: cursors.get(service),
      }).catch(handleAgentError(service));

      streams.push({ service, stream });
    }
  } catch (error) {
    stopStreams(streams);
    throw error;
  }

  return streams;
}

const MERGED_LINES = 10_000;

function countLinesPerService(request: Readonly<ServiceLogsRequest>, count: number): number {
  if (request.service !== undefined) {
    return request.lines;
  }

  return Math.min(request.lines, Math.floor(MERGED_LINES / Math.max(count, 1)));
}

function handleAgentError(service: string): (error: unknown) => never {
  return (error) => {
    if (isAgentError(error, 'NO_SERVICE')) {
      throw buildNotFoundError('service', service);
    }

    if (isAgentError(error, 'SERVICE_EXISTS')) {
      throw buildConflictError('service', service);
    }

    if (isAgentError(error, 'BAD_REQUEST')) {
      throw new ImpdError('BAD_REQUEST', { message: error.detail });
    }

    if (isAgentError(error, 'AGENT_OUTDATED')) {
      throw buildAgentOutdatedApiError(error.message);
    }

    throw error;
  };
}

function stopStreams(streams: readonly NamedStream[]): void {
  for (const entry of streams) {
    entry.stream.close();
  }
}

async function* readLogs(
  streams: readonly NamedStream[],
): AsyncGenerator<ServiceLog, void, undefined> {
  const decoders = createLogDecoders();

  for await (const item of mergeLogStreams(streams, decoders)) {
    if (item.text !== '') {
      yield { type: 'log', service: item.service, text: item.text };
    }
  }

  yield* decoders.readRest();
}

function createFollowControl(): FollowControl {
  const abort = new AbortController();

  let open: readonly NamedStream[] = [];

  return {
    readStreams: () => open,
    setStreams: (streams) => {
      open = streams;
    },
    signal: abort.signal,
    stop: () => {
      abort.abort();

      stopStreams(open);
    },
  };
}

// An imp event can pass before the follow subscribes, so a follow of an imp
// that does not run looks again on a timer too.
const FOLLOW_RECHECK_MS = 5000;
const FOLLOW_RETRY_MS = 500;
const FOLLOW_OPEN_TRIES = 5;

async function* readFollowedLogs(
  context: FollowContext,
  name: string,
  request: Readonly<ServiceLogsRequest>,
  control: FollowControl,
): AsyncGenerator<ServiceLog, void, undefined> {
  const cursors = new Map<string, LogCursor>();

  const decoders = createLogDecoders();
  const signal = control.signal;
  let said: ImpRecord['state'] | null = null;
  let failures = 0;

  for (;;) {
    if (control.readStreams().length === 0) {
      const found = await context.runtime.readAgent(name, 'services').catch((error: unknown) => {
        if (isImpdError(error, 'NOT_FOUND')) {
          return null;
        }

        return handleAgentError('')(error);
      });

      if (signal.aborted || found === null) {
        break;
      }

      if (found.vsockPath === null) {
        failures = 0;

        const changed = found.imp.state !== said && found.imp.state !== 'running';

        if (said === null || changed) {
          said = found.imp.state;
          yield { type: 'sleeping', state: found.imp.state };
        }

        const waitMs = found.imp.state === 'running' ? FOLLOW_RETRY_MS : FOLLOW_RECHECK_MS;

        await waitForImpChange(context, name, signal, waitMs);

        continue;
      }

      try {
        const services = await listServiceNames(found.vsockPath, request);
        const streams = await openLogStreams(found.vsockPath, services, request, cursors);

        control.setStreams(streams);

        failures = 0;
      } catch (error) {
        failures += 1;

        if (failures >= FOLLOW_OPEN_TRIES) {
          throw error;
        }

        await waitForImpChange(context, name, signal, FOLLOW_RETRY_MS);

        continue;
      }
    }

    if (said !== null) {
      said = null;
      yield { type: 'awake' };
    }

    try {
      for await (const item of mergeLogStreams(control.readStreams(), decoders)) {
        if (item.chunk.kind === 'cursor') {
          cursors.set(item.service, item.chunk.cursor);
        } else if (item.text !== '') {
          yield { type: 'log', service: item.service, text: item.text };
        }
      }
    } catch {
      // The connection drops when the VM sleeps or stops.
    }

    stopStreams(control.readStreams());

    control.setStreams([]);

    if (signal.aborted) {
      break;
    }

    await waitForImpChange(context, name, signal, FOLLOW_RETRY_MS);
  }

  yield* decoders.readRest();

  if (context.restart.started) {
    yield { type: 'restarting' };
  }
}

const LIST_WAIT_MS = 10_000;

async function readRunningAgent(
  context: Readonly<WaitContext>,
  name: string,
): Promise<{ readonly imp: ImpRecord; readonly vsockPath: string | null }> {
  const runtime = context.runtime;
  const deadline = context.now() + LIST_WAIT_MS;

  for (;;) {
    const found = await runtime.readAgent(name);

    if (found.vsockPath !== null || found.imp.state === 'sleeping') {
      return found;
    }

    if (found.imp.state !== 'running' || context.now() > deadline) {
      throw buildInvalidStateError(
        found.imp.state,
        ['running', 'sleeping'],
        'list the services of',
      );
    }

    const waited = Promise.withResolvers<undefined>();

    context.startTimer(() => {
      waited.resolve(undefined);
    }, FOLLOW_RETRY_MS);

    await waited.promise;
  }
}

function toApiService(service: ServiceStatus): Service {
  const def = service.def;
  const exit = service.lastExit;

  return {
    name: service.name,
    state: ServiceStateSchema.parse(service.state),
    pid: service.pid === undefined || service.pid === 0 ? null : service.pid,
    restarts: service.restarts,
    lastExit:
      exit === undefined
        ? null
        : {
            code: exit.code,
            signal: exit.signal === 0 ? null : getSignalName(exit.signal),
          },
    argv: [...(def?.argv ?? [])],
    envKeys: (def?.env ?? []).map((entry) => entry.split('=', 1)[0] ?? entry),
    cwd: def?.cwd ?? null,
    user: def?.user ?? null,
    restart: ServiceRestartSchema.parse(def?.restart ?? 'always'),
    source: def?.source === 'api' ? 'api' : 'image',

    root: service.root ?? true,
  };
}

function requireExecRights(
  listed: ServicesList,
  def: Readonly<ServiceDef>,
  replace: boolean,
): void {
  if (def.user !== undefined && def.user !== listed.imageUser) {
    throw buildForbiddenError(
      `service ${def.name} runs as ${def.user}, not the image's user: that needs the manage scope`,
    );
  }

  const old = listed.services.find((entry) => entry.name === def.name);

  if (replace && old !== undefined && old.root !== false) {
    throw buildForbiddenError(
      `service ${def.name} runs as root: replacing it needs the manage scope`,
    );
  }
}

function requireNotRoot(listed: ServicesList, service: string, action: string): void {
  const found = listed.services.find((entry) => entry.name === service);

  if (found?.root === false) {
    return;
  }

  const why = found === undefined ? 'is not running yet' : 'runs as root';

  throw buildForbiddenError(`service ${service} ${why}: to ${action} it needs the manage scope`);
}
