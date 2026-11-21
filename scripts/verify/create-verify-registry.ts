import { join } from 'node:path';
import { WringerError, createHostUploader, createWringer, local } from '@wringer/core';
import type { DriverConfigContext, LaunchContext, LaunchPlan, Wringer } from '@wringer/core';
import { http } from '@wringer/http';
import { mcp } from '@wringer/mcp';
import { stream } from '@wringer/stream';
import { terminal } from '@wringer/terminal';
import * as z from 'zod';
import { buildMCPConfig } from './build-mcp-config.ts';
import { buildTerminalConfig } from './build-terminal-config.ts';
import { checkHost } from './check-host.ts';
import { checkMCPRoute } from './check-mcp-route.ts';
import { checkServiceClient } from './check-service-client.ts';
import {
  LAUNCH_TARGETS,
  PROD_CLIENT_NAME,
  PROD_CLIENT_SCOPE,
  PROD_SECRET_ENV,
  RUN_DIRECTORY_ENV,
  SERVICE_CLIENT_NAME,
  SERVICE_CLIENT_SCOPE,
  SERVICE_SECRET_ENV,
} from './constants.ts';
import { createImp } from './create-imp.ts';
import { createServiceClient } from './create-service-client.ts';
import { featurePaths, ignoredPaths, sharedPaths } from './feature-paths.ts';
import { listImps } from './list-imps.ts';
import { makeLaunchCommand } from './make-launch-command.ts';
import { parseProdEndpoints } from './parse-prod-endpoints.ts';
import { readImpEvents } from './read-imp-events.ts';
import { removeImp } from './remove-imp.ts';
import { parseRunEndpoints } from './run-endpoints.ts';
import { runImpCommand } from './run-imp-command.ts';
import { sleepImp } from './sleep-imp.ts';

const impName = z.string().regex(/^wv-[a-z0-9-]+$/u, 'Name a verify imp wv-<name>.');
const nameInput = z.strictObject({ name: impName });
const commandInput = z.strictObject({ name: impName, command: z.string().min(1) });
const noInput = z.strictObject({});
const impData = z.strictObject({ name: z.string(), state: z.string() });
const removedData = z.strictObject({ removed: z.string(), existed: z.boolean() });
const impsData = z.strictObject({ imps: z.array(impData) });

const commandData = z.strictObject({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

const eventStep = z.strictObject({
  ev: z.string(),
  reason: z.string().nullable(),
  state: z.string(),
});

const eventsData = z.strictObject({ events: z.array(eventStep) });
const healthSchema = z.object({ status: z.literal('ok'), ready: z.boolean() });
const toolsData = z.strictObject({ tools: z.number().int() });
const routeData = z.strictObject({ url: z.string() });

// The registry's name is not `impz`: gunshi reads a command group named like the program as the
// program itself.
export function createVerifyRegistry(): Wringer {
  return createWringer({ name: 'impz-verify' })
    .use(http({}))
    .use(stream({}))
    .use(terminal({ cols: 120, rows: 30 }))
    .use(mcp({}))
    .target('local', {
      mode: 'launch',
      access: 'read-write',
      evidence: 'upload',
      host: local(),
      launch: (ctx) => createLaunchPlan(ctx, 'run-local-impd.ts', null),
      drivers: {
        http: () => ({ healthPath: '/health' }),
        stream: buildStreamConfig,
        terminal: readTerminalConfig,
        mcp: buildRunMCPConfig,
      },
    })
    .target('local-kvm', {
      mode: 'launch',
      access: 'read-write',
      evidence: 'upload',
      host: local(),
      launch: (ctx) => createLaunchPlan(ctx, 'run-kvm-impd.ts', 'remove-kvm-instance.ts'),
      drivers: {
        http: () => ({ healthPath: '/health' }),
        stream: buildStreamConfig,
        terminal: readTerminalConfig,
        mcp: buildRunMCPConfig,
      },
    })
    .target('prod', {
      mode: 'attach',
      access: 'read-only',
      refusalHint:
        'prod is the deployed impd, and it is read-only. Leave the write undone, run no `done` there, and report the write you needed.',
      host: local(),
      endpoints: () => parseProdEndpoints(process.env),
      drivers: {
        mcp: (ctx) =>
          buildMCPConfig(z.url().parse(ctx.endpoints['mcp']), {
            name: PROD_CLIENT_NAME,
            secretEnv: PROD_SECRET_ENV,
            scope: PROD_CLIENT_SCOPE,
          }),
      },
    })
    .action({
      name: 'create-imp',
      summary: 'Create the imp from the tiny image, as an operator with the root token',
      effect: 'write',
      targets: LAUNCH_TARGETS,
      input: nameInput,
      data: impData,
      run: (input, ctx) => createImp(ctx.endpoints, input.name),
    })
    .action({
      name: 'sleep-imp',
      summary: 'Put the imp to sleep, as an operator with the root token',
      effect: 'write',
      targets: LAUNCH_TARGETS,
      input: nameInput,
      data: impData,
      run: (input, ctx) => sleepImp(ctx.endpoints, input.name),
    })
    .action({
      name: 'destroy-imp',
      summary:
        'Destroy the imp, as an operator with the root token; an imp already gone is a no-op',
      effect: 'write',
      targets: LAUNCH_TARGETS,
      input: nameInput,
      data: removedData,
      run: (input, ctx) => removeImp(ctx.endpoints, input.name),
    })
    .action({
      name: 'exec-imp',
      summary: 'Run `sh -c` with the command in the imp, which wakes it; needs local-kvm',
      effect: 'write',
      targets: ['local-kvm'],
      input: commandInput,
      data: commandData,
      run: (input, ctx) => runImpCommand(ctx.endpoints, input.name, input.command),
    })
    .command({
      path: ['imps', 'list'],
      summary: 'List every imp with its state, as an operator with the root token',
      effect: 'read',
      args: noInput,
      data: impsData,
      run: makeLaunchCommand((_args, ctx) => listImps(ctx.endpoints)),
    })
    .command({
      path: ['imp-events'],
      summary:
        'Check that `impz events` printed, since `use` marked the stream, the imp added, running, asleep and removed, in order',
      effect: 'read',
      args: nameInput,
      data: eventsData,
      run: makeLaunchCommand((args, ctx) => readImpEvents(ctx.drivers.stream, args.name)),
    })
    .check({
      name: 'host',
      targets: LAUNCH_TARGETS,
      input: noInput,
      data: z.null(),
      timeoutMs: 1000,
      run: (_input, ctx) => checkHost(ctx.endpoints),
    })
    .check({
      name: 'impd-ready',
      targets: LAUNCH_TARGETS,
      input: noInput,
      data: z.null(),
      timeoutMs: 10_000,
      run: async (_input, ctx) => {
        const response = await ctx.drivers.http.request({ path: '/health' });

        const health = healthSchema.parse(response.json);

        if (!health.ready) {
          throw new WringerError('check-failed', {
            message: 'impd answers /health but is not ready',
          });
        }

        return null;
      },
    })
    .check({
      name: 'mcp-route',
      input: noInput,
      data: routeData,
      timeoutMs: 10_000,
      run: (_input, ctx) => checkMCPRoute(ctx.endpoints, ctx.signal),
    })
    .check({
      name: 'service-client',
      input: noInput,
      data: toolsData,
      timeoutMs: 15_000,
      run: (_input, ctx) => checkServiceClient(ctx.drivers.mcp),
    })
    .feature(
      {
        name: 'api-lifecycle',
        summary:
          'Create, list, sleep and destroy an imp through the API, and follow it in `impz events`',
        paths: featurePaths['api-lifecycle'],
      },
      {
        name: 'mcp-scope',
        summary: 'As a service client, create an imp in its scope and be refused one outside it',
        paths: featurePaths['mcp-scope'],
      },
      {
        name: 'mcp-reads',
        summary: 'As a service client on the public MCP route, list the imps, images and events',
        paths: featurePaths['mcp-reads'],
      },
      {
        name: 'cli-create-exec',
        summary:
          'Create an imp with `impz new` and run `uname -a` in it with `impz exec`, on a real VM',
        paths: featurePaths['cli-create-exec'],
      },
      {
        name: 'sleep-wake',
        summary:
          'Write a file in an imp, sleep it, wake it with an exec, and read the file back, on a real VM',
        paths: featurePaths['sleep-wake'],
      },
      {
        name: 'checkpoint-restore-fork',
        summary:
          'Checkpoint an imp over MCP, change a file, restore, then fork the checkpoint, on a real VM',
        paths: featurePaths['checkpoint-restore-fork'],
      },
    )
    .hook(
      'upload',
      createHostUploader({ urlEnv: 'CLOUD_FILES_URL', tokenEnv: 'CLOUD_FILES_TOKEN' }),
    )
    .shared(...sharedPaths)
    .ignore(...ignoredPaths)
    .build();
}

const scriptsDir = import.meta.dir;

// The launch plan mints the run's service client, so each run's MCP sign-in is its own. The stop
// command, when the target has one, runs before the app's SIGTERM.
function createLaunchPlan(ctx: LaunchContext, app: string, stop: string | null): LaunchPlan {
  return {
    command: [process.execPath, join(scriptsDir, app)],
    env: { [RUN_DIRECTORY_ENV]: ctx.runDirectory, ...createServiceClient() },
    ...(stop === null ? {} : { stop: [process.execPath, join(scriptsDir, stop)] }),
    ready: (line) => (line['event'] === 'ready' ? parseRunEndpoints(line) : null),
  };
}

function buildStreamConfig(ctx: DriverConfigContext) {
  const run = parseRunEndpoints(ctx.endpoints);

  return {
    sources: {
      events: {
        command: ['env', `XDG_CONFIG_HOME=${run.configHome}`, join(run.bin, 'impz'), 'events'],
      },
    },
  };
}

function readTerminalConfig(ctx: DriverConfigContext) {
  return buildTerminalConfig(ctx.endpoints, process.env['PATH'] ?? '');
}

function buildRunMCPConfig(ctx: DriverConfigContext) {
  return buildMCPConfig(parseRunEndpoints(ctx.endpoints).mcp, {
    name: SERVICE_CLIENT_NAME,
    secretEnv: SERVICE_SECRET_ENV,
    scope: SERVICE_CLIENT_SCOPE,
  });
}
