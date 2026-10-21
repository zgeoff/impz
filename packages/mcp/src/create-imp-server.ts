import { hasScope } from '@impz/api';
import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type { CallToolRequest, ServerContext } from '@modelcontextprotocol/server';
import { runAfter } from './after';
import type { After } from './after';
import type { CallRegistry } from './create-call-registry';
import { findCallerAuth } from './create-caller-auth';
import type { McpCaller } from './create-caller-auth';
import { runOnInterval } from './repeat';
import type { Repeat } from './repeat';
import type { Tool } from './tools/define-tool';
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

// oxlint-disable-next-line no-deprecated -- the low-level Server lets tools/list filter by caller and a fallback answer unknown methods
type ImpServer = Server;

export function createImpServer(
  options: Readonly<ImpServerOptions>,
  caller: Readonly<McpCaller>,
  calls: Readonly<CallRegistry>,
): ImpServer {
  const tools = new Map<string, Tool>(TOOLS.map((tool) => [tool.definition.name, tool]));

  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const repeat = options.repeat ?? runOnInterval;
  const after = options.after ?? runAfter;
  const printError = options.printError ?? console.error;

  // oxlint-disable-next-line no-deprecated -- the ImpServer type above says why
  const server = new Server(
    { name: 'imp', title: 'imp', version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: [
        'imp runs persistent Linux microVMs ("imps") that sleep when idle and wake on use.',
        `This server may touch ${caller.guard.summary}.`,
        'Create an imp, run commands and read and write files in it, checkpoint before a risky change, fork to try two fixes, and destroy what you no longer need.',
      ].join(' '),
      supportedProtocolVersions: [...PROTOCOL_VERSIONS, ...MODERN_PROTOCOL_VERSIONS],
    },
  );

  // The SDK's own answer to an unknown method does not name the method.
  server.fallbackRequestHandler = (request) =>
    Promise.reject(
      new ProtocolError(ProtocolErrorCode.MethodNotFound, `unknown method: ${request.method}`),
    );

  server.setRequestHandler('tools/list', (_request, ctx) => {
    const scope = (findCallerAuth(ctx.http?.authInfo)?.caller ?? caller).scope;

    return {
      tools: TOOLS.filter((tool) => hasScope(scope, tool.scope)).map((tool) => tool.definition),
    };
  });

  const runToolCall = async (request: CallToolRequest, ctx: ServerContext) => {
    const id = ctx.mcpReq.id;
    const tool = tools.get(request.params.name);

    if (tool === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `unknown tool: ${request.params.name}`,
      );
    }

    const requestCaller = findCallerAuth(ctx.http?.authInfo)?.caller ?? caller;

    // The SDK drops a cancelled request's answer, so a call that cannot be
    // cancelled gets its own controller, which only the gate aborts.
    const abort = new AbortController();

    const done = Promise.withResolvers<void>();

    const stopCall = (): void => {
      abort.abort(ctx.mcpReq.signal.reason);
    };

    ctx.mcpReq.signal.addEventListener('abort', stopCall, { once: true });
    calls.add(id, { abort, cancellable: tool.cancellable, done: done.promise });

    const stopProgress = startProgress(ctx, {
      intervalMs: progressIntervalMs,
      repeat,
      signal: abort.signal,
    });

    try {
      return await tool.call(request.params.arguments, {
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

      throw new ProtocolError(ProtocolErrorCode.InternalError, 'internal error');
    } finally {
      stopProgress();

      ctx.mcpReq.signal.removeEventListener('abort', stopCall);
      calls.remove(id);
      done.resolve();
    }
  };

  server.setRequestHandler('tools/call', async (request, ctx) => {
    findCallerAuth(ctx.http?.authInfo)?.onCallStart();

    try {
      return await runToolCall(request, ctx);
    } finally {
      findCallerAuth(ctx.http?.authInfo)?.onCallEnd();
    }
  });

  return server;
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
