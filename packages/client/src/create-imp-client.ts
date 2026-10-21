import type { Image, Imp, ImpContract } from '@impz/api';
import { createORPCClient } from '@orpc/client';
import type { ClientContext } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RPCLinkOptions } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { checkServer } from './check-server';
import type { CheckServerOptions, ServerCheck } from './check-server';
import { openAttach, openConsole, openExec, runCommand } from './exec/open-exec';
import type {
  AttachOptions,
  ConsoleOptions,
  ExecDeps,
  ExecHandle,
  ExecOptions,
  RunOptions,
  RunResult,
} from './exec/open-exec';
import type { ExecSocket } from './exec/open-exec-session';
import { requireAwake } from './require-awake';
import type { RequireAwakeOptions } from './require-awake';
import { resolveImpdUrl } from './resolve-impd-url';
import { runImageBuild } from './run-image-build';
import type { BuildContext, BuildImageOptions } from './run-image-build';
import { LONG_CALL_DEADLINES_MS, sendLongCall } from './send-long-call';
import type { CallInit, StartTimer } from './send-long-call';
import { UnknownProcedureError } from './unknown-procedure-error';

type RpcClient = ContractRouterClient<ImpContract>;

type LinkFetch = NonNullable<RPCLinkOptions<ClientContext>['fetch']>;

export interface ImpClientOptions {
  readonly url: string;
  readonly token?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly connect?: (url: string) => ExecSocket;
  readonly startTimer?: StartTimer;
}

export interface ImpClient extends RpcClient {
  readonly requireAwake: (name: string, options?: RequireAwakeOptions) => Promise<Imp>;
  readonly checkServer: (options?: CheckServerOptions) => Promise<ServerCheck>;
  readonly buildImage: (
    name: string,
    context: BuildContext,
    options?: BuildImageOptions,
  ) => Promise<Image>;
  readonly openExec: (
    name: string,
    argv: readonly string[],
    options?: ExecOptions,
  ) => Promise<ExecHandle>;
  readonly run: (name: string, argv: readonly string[], options?: RunOptions) => Promise<RunResult>;
  readonly openConsole: (name: string, options?: ConsoleOptions) => Promise<ExecHandle>;
  readonly openAttach: (
    name: string,
    session: string,
    options?: AttachOptions,
  ) => Promise<ExecHandle>;
}

export function createImpClient(options: Readonly<ImpClientOptions>): ImpClient {
  const token = options.token;
  const customFetch = options.fetch;
  const startTimer = options.startTimer ?? startRealTimer;

  const sendCall = (request: Request, init: Readonly<CallInit>): Promise<Response> =>
    customFetch === undefined ? fetch(request, init) : customFetch(request);

  const sendLinkRequest: LinkFetch = async (request, init, _options, path) => {
    const procedure = path.join('.');
    const deadlineMs = LONG_CALL_DEADLINES_MS.get(procedure);

    const sent =
      deadlineMs === undefined
        ? sendCall(request, init)
        : sendLongCall(request, init, {
            procedure,
            deadlineMs,
            startTimer,
            send: customFetch ?? null,
          });

    const response = await sent;

    if (isUnknownProcedure(response.status, response.headers.get('content-type'))) {
      await response.body?.cancel();

      throw new UnknownProcedureError(procedure);
    }

    return response;
  };

  const link = new RPCLink({
    url: resolveImpdUrl(options.url, '/rpc').href,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    fetch: sendLinkRequest,
  });

  const rpc: RpcClient = createORPCClient(link);

  // The oRPC client is a proxy that a spread cannot copy.
  const namespaces = {
    imps: rpc.imps,
    leases: rpc.leases,
    checkpoints: rpc.checkpoints,
    backups: rpc.backups,
    images: rpc.images,
    exec: rpc.exec,
    sessions: rpc.sessions,
    services: rpc.services,
    files: rpc.files,
    moves: rpc.moves,
    secrets: rpc.secrets,
    networks: rpc.networks,
    grants: rpc.grants,
    audit: rpc.audit,
    events: rpc.events,
    system: rpc.system,
    tokens: rpc.tokens,
    oauth: rpc.oauth,
    auth: rpc.auth,
  } satisfies RpcClient;

  const execDeps: ExecDeps = {
    rpc,
    baseUrl: options.url,
    token: token ?? null,
    ...(customFetch !== undefined && { fetch: customFetch }),
    ...(options.connect !== undefined && { connect: options.connect }),
  };

  return {
    ...namespaces,
    openExec: (name, argv, execOptions) => openExec(execDeps, name, argv, execOptions),
    run: (name, argv, runOptions) => runCommand(execDeps, name, argv, runOptions),
    openConsole: (name, consoleOptions) => openConsole(execDeps, name, consoleOptions),
    openAttach: (name, session, attachOptions) =>
      openAttach(execDeps, name, session, attachOptions),
    requireAwake: (name, awakeOptions) => requireAwake(rpc, name, awakeOptions),
    checkServer: (checkOptions) => checkServer(rpc, checkOptions),
    // oxlint-disable-next-line zgeoff/verb-contract -- a method of the published client
    buildImage: (name, context, buildOptions) =>
      runImageBuild(execDeps, name, context, buildOptions),
  };
}

function startRealTimer(fire: () => void, durationMs: number): () => void {
  const timer = setTimeout(fire, durationMs);

  return () => {
    clearTimeout(timer);
  };
}

// oRPC answers every error, a missing imp's NOT_FOUND among them, as JSON;
// impd's own 404 for a path no procedure matches is plain text.
function isUnknownProcedure(status: number, contentType: string | null): boolean {
  return status === 404 && !(contentType ?? '').startsWith('application/json');
}
