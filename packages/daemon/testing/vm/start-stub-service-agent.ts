import type { Socket } from 'node:net';
import { create, toJson } from '@bufbuild/protobuf';
import type { JsonValue } from '@bufbuild/protobuf';
import { RequestSchema, ServiceStatusSchema } from '../../src/vm/agent-client/agent-protocol';
import type { Request, ServiceDef, ServiceStatus } from '../../src/vm/agent-client/agent-protocol';
import { decodeAgentMessage } from '../../src/vm/agent-client/decode-agent-message';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '../../src/vm/agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

const IMAGE_USER = 'dev';
const LOG_INODE = 7;
const MAX_LOG_LINES = 100_000;

interface Follow {
  readonly service: string;
  readonly socket: Socket;
  isClosed: boolean;
}

interface StubServiceAgentOptions {
  readonly knowsServices: boolean;

  readonly stack?: Readonly<AsyncDisposableStack>;
}

export async function startStubServiceAgent(
  vsockPath: string,
  options: Readonly<StubServiceAgentOptions>,
) {
  const services: ServiceStatus[] = [];
  const requests: Request[] = [];

  const logs = new Map<string, Buffer>();

  const follows: Follow[] = [];
  const failing = { logs: false, list: false };
  const pids = { next: 40 };

  const allocatePid = (): number => {
    const pid = pids.next;

    pids.next += 1;

    return pid;
  };

  const toService = (def: ServiceDef): ServiceStatus =>
    create(ServiceStatusSchema, {
      name: def.name ?? '',
      state: 'running',
      pid: allocatePid(),
      restarts: 0,
      ...(options.knowsServices && {
        def: { ...def, restart: def.restart ?? 'always', source: 'api' },
        root: (def.user ?? IMAGE_USER) === 'root',
      }),
    });

  const sendLog = (socket: Socket, data: Uint8Array, end: number): void => {
    socket.write(encodeFrame(FRAME_TYPES.stdout, data));
    socket.write(encodeJsonFrame(FRAME_TYPES.cursor, { inode: LOG_INODE, offset: end }));
  };

  const getLogStart = (log: Buffer, request: Request): number => {
    if (request.cursor === undefined) {
      return getLastLinesStartOffset(log, request.lines ?? 0);
    }

    const cursor = request.cursor;

    return cursor.inode === LOG_INODE && cursor.offset <= log.length ? cursor.offset : 0;
  };

  const handleLogs = (socket: Socket, request: Request): void => {
    const service = request.service ?? '';
    const log = logs.get(service) ?? Buffer.alloc(0);
    const lines = request.lines ?? 0;

    if (lines < 0 || lines > MAX_LOG_LINES) {
      sendError(socket, 'BAD_REQUEST', 'lines: want 0 to 100000');

      return;
    }

    if (failing.logs) {
      sendError(socket, 'INTERNAL', 'the log could not be read');

      return;
    }

    const from = getLogStart(log, request);

    socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));

    if (from < log.length) {
      sendLog(socket, log.subarray(from), log.length);
    }

    if (request.follow !== true) {
      socket.end(encodeFrame(FRAME_TYPES.stdoutEof));

      return;
    }

    const follow: Follow = { service, socket, isClosed: false };

    follows.push(follow);

    socket.on('close', () => {
      follow.isClosed = true;
    });
  };

  const handleAdd = (socket: Socket, request: Request): void => {
    const def = request.def;

    if (def === undefined || def.argv[0] === 'bad') {
      sendError(socket, 'BAD_REQUEST', 'argv is bad');

      return;
    }

    const taken = services.findIndex((service) => service.name === def.name);

    if (taken !== -1 && request.replace !== true) {
      sendError(socket, 'SERVICE_EXISTS', `service ${def.name} exists`);

      return;
    }

    const at = taken === -1 ? services.length : taken;

    services.splice(at, 1, toService(def));

    sendResponse(socket, { ok: true });
  };

  const handleChange = (socket: Socket, request: Request): void => {
    const name = request.service ?? '';
    const index = services.findIndex((service) => service.name === name);
    const service = services[index];

    if (service === undefined) {
      sendError(socket, 'NO_SERVICE', `no service ${name}`);

      return;
    }

    if (request.op === 'services.remove') {
      services.splice(index, 1);
    } else {
      const { lastExit: _lastExit, ...kept } = service;

      services.splice(index, 1, { ...kept, state: 'running', pid: allocatePid(), restarts: 0 });
    }

    sendResponse(socket, { ok: true });
  };

  const handleRequest = (socket: Socket, request: Request): void => {
    requests.push(request);

    const name = request.service ?? '';
    const isKnown = services.some((service) => service.name === name) || logs.has(name);

    if (request.op === 'services.list' && failing.list) {
      sendError(socket, 'INTERNAL', 'the services could not be listed');
    } else if (request.op === 'services.list') {
      const listed = services
        .toSorted((left, right) => (left.name < right.name ? -1 : 1))
        .map((service) =>
          toJson(ServiceStatusSchema, service, {
            useProtoFieldName: true,
            alwaysEmitImplicit: true,
          }),
        );

      const answer = options.knowsServices
        ? { services: listed, image_user: IMAGE_USER }
        : { services: listed };

      sendResponse(socket, answer);
    } else if (!options.knowsServices) {
      sendError(socket, 'UNKNOWN_OP', `unknown op ${request.op}`);
    } else if (request.op === 'services.add') {
      handleAdd(socket, request);
    } else if (request.op === 'services.remove' || request.op === 'services.restart') {
      handleChange(socket, request);
    } else if (request.op === 'services.logs' && !isKnown) {
      sendError(socket, 'NO_SERVICE', `no service ${name}`);
    } else if (request.op === 'services.logs') {
      handleLogs(socket, request);
    } else {
      sendError(socket, 'UNKNOWN_OP', `unknown op ${request.op}`);
    }
  };

  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  const agent = await startStubAgent(
    vsockPath,
    (socket, request, frames) => {
      if (frames.length === 1) {
        handleRequest(socket, decodeAgentMessage(RequestSchema, decodeJsonPayload(request)));
      }
    },
    closeWith,
  );

  return {
    services,
    requests,
    follows,
    failing,
    close: agent.close,

    writeLog: (service: string, text: string | Uint8Array): void => {
      const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
      const log = Buffer.concat([logs.get(service) ?? Buffer.alloc(0), data]);

      logs.set(service, log);

      for (const follow of follows) {
        if (follow.service === service && !follow.isClosed) {
          sendLog(follow.socket, data, log.length);
        }
      }
    },

    stopFollows: (): void => {
      for (const follow of follows) {
        follow.socket.destroy();
      }
    },
  };
}

const NEWLINE = 0x0a;

function getLastLinesStartOffset(log: Buffer, count: number): number {
  if (count === 0) {
    return log.length;
  }

  const body = log.at(-1) === NEWLINE ? log.length - 1 : log.length;
  let found = 0;

  for (let at = body - 1; at >= 0; at -= 1) {
    if (log[at] === NEWLINE) {
      found += 1;

      if (found === count) {
        return at + 1;
      }
    }
  }

  return 0;
}

function sendError(socket: Socket, code: string, message: string): void {
  sendResponse(socket, { error: { code, message } });
}

function sendResponse(socket: Socket, value: JsonValue): void {
  socket.end(encodeJsonFrame(FRAME_TYPES.response, value));
}
