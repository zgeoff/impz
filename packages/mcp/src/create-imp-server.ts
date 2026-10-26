import { hasScope } from '@impz/api';
import type { Scope } from '@impz/api';
import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';
import { runAfter } from './after';
import type { After } from './after';
import type { CallRegistry } from './create-call-registry';
import { findCallerAuth } from './create-caller-auth';
import type { McpCaller } from './create-caller-auth';
import { runOnInterval } from './repeat';
import type { Repeat } from './repeat';
import type { Tool, ToolCallRunner } from './tools/define-tool';
import { TOOLS } from './tools/tool-list';

// Newest first: the SDK answers a client that asks for another version with
// the first one.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'];
const PROGRESS_INTERVAL_MS = 15_000;
const KILL_GRACE_MS = 2000;

export interface ImpServerOptions {
  readonly version: string;
  readonly progressIntervalMs?: number;
  readonly killGraceMs?: number;
  readonly repeat?: Repeat;
  readonly after?: After;

  // Defaults to stderr, because stdout carries a stdio transport's messages.
  readonly printError?: (message: string, error: unknown) => void;
}

export function createImpServer(
  options: Readonly<ImpServerOptions>,
  caller: Readonly<McpCaller>,
  calls: Readonly<CallRegistry>,
): McpServer {
  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const repeat = options.repeat ?? runOnInterval;
  const after = options.after ?? runAfter;
  const printError = options.printError ?? console.error;

  const server = new McpServer(
    { name: 'imp', title: 'imp', version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: buildInstructions(caller),
      supportedProtocolVersions: [...PROTOCOL_VERSIONS, ...MODERN_PROTOCOL_VERSIONS],
    },
  );

  // The SDK's own answer to an unknown method does not name the method.
  server.server.fallbackRequestHandler = (request) =>
    Promise.reject(
      new ProtocolError(ProtocolErrorCode.MethodNotFound, `unknown method: ${request.method}`),
    );

  // The SDK lists every registered tool to every caller.
  server.server.setRequestHandler('tools/list', (_request, ctx) => {
    const scope = (findCallerAuth(ctx.http?.authInfo)?.caller ?? caller).scope;

    return {
      tools: TOOLS.filter((tool) => hasScope(scope, tool.scope)).map((tool) => tool.definition),
    };
  });

  const makeCallRunner =
    (tool: Readonly<Tool>): ToolCallRunner =>
    async (ctx, call) => {
      const id = ctx.mcpReq.id;
      const auth = findCallerAuth(ctx.http?.authInfo);
      const requestCaller = auth?.caller ?? caller;

      auth?.onCallStart();

      // The SDK drops a cancelled request's answer, so a call that cannot be
      // cancelled gets its own controller, which only the gate aborts.
      const abort = new AbortController();

      const done = Promise.withResolvers<void>();

      const stopCall = (): void => {
        abort.abort(ctx.mcpReq.signal.reason);
      };

      // The SDK checks the arguments before this runs, and a cancel can land
      // during that check.
      if (ctx.mcpReq.signal.aborted) {
        stopCall();
      }

      ctx.mcpReq.signal.addEventListener('abort', stopCall, { once: true });
      calls.add(id, { abort, cancellable: tool.cancellable, done: done.promise });

      const stopProgress = startProgress(ctx, {
        intervalMs: progressIntervalMs,
        repeat,
        signal: abort.signal,
      });

      try {
        return await call({
          client: requestCaller.client,
          guard: requestCaller.guard,
          signal: abort.signal,
          killGraceMs,
          after,
        });
      } catch (error) {
        // The SDK drops a cancelled call's answer.
        if (!abort.signal.aborted || !tool.cancellable) {
          printError('impz mcp: request failed:', error);
        }

        return { content: [{ type: 'text', text: 'internal error' }], isError: true };
      } finally {
        stopProgress();

        ctx.mcpReq.signal.removeEventListener('abort', stopCall);
        calls.remove(id);
        done.resolve();
        auth?.onCallEnd();
      }
    };

  for (const tool of TOOLS) {
    tool.register(server, makeCallRunner(tool));
  }

  return server;
}

// A client reads the instructions as what the server can do, so a narrower
// scope says what it lacks rather than offering tools it hides.
const SCOPE_GUIDES: Readonly<Record<Scope, string>> = {
  read: 'This caller has the read scope, so it can only look: list imps, their URLs, the images and the checkpoints. Running commands, reading or writing files, and creating, checkpointing, forking or destroying an imp need a wider grant: exec or manage.',
  exec: 'This caller has the exec scope: list imps, their URLs, the images and the checkpoints, run commands and read and write files in an imp, and put one to sleep. Creating, checkpointing, restoring, forking or destroying an imp needs a manage grant.',
  manage:
    'Create an imp, run commands and read and write files in it, checkpoint before a risky change, fork to try two fixes, and destroy what you no longer need.',
};

function buildInstructions(caller: Readonly<McpCaller>): string {
  const names = TOOLS.filter((tool) => hasScope(caller.scope, tool.scope)).map(
    (tool) => tool.definition.name,
  );

  return [
    'imp runs persistent Linux microVMs ("imps") that sleep when idle and wake on use.',
    `This server may touch ${caller.guard.summary}.`,
    SCOPE_GUIDES[caller.scope],
    `Its tools: ${names.join(', ')}.`,
  ].join(' ');
}

interface ProgressOptions {
  readonly intervalMs: number;
  readonly repeat: Repeat;
  readonly signal: Readonly<AbortSignal>;
}

// Progress notifications let a client keep its own timeout from ending a long
// call.
function startProgress(ctx: ServerContext, options: Readonly<ProgressOptions>): () => void {
  // oxlint-disable-next-line no-underscore-dangle -- MCP names the field _meta
  const token = ctx.mcpReq._meta?.progressToken;

  if (token === undefined) {
    return () => {};
  }

  const started = Date.now();
  let progress = 0;

  const stopTimer = options.repeat(options.intervalMs, () => {
    progress += 1;

    const seconds = Math.round((Date.now() - started) / 1000);

    void ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress,
        message: `still running after ${String(seconds)} s`,
      },
    });
  });

  const stop = (): void => {
    stopTimer();

    options.signal.removeEventListener('abort', stop);
  };

  options.signal.addEventListener('abort', stop, { once: true });

  return stop;
}
