import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { ForkResult } from '@impz/api';
import { CONSOLE_SHELL, EXEC_REQUIREMENTS, requireFeatures } from '@impz/client';
import type { ExecRequirement } from '@impz/client';
import { detachKeyArg, jsonArg, nameArg, requireSessionName } from '../args/common-args';
import { defineCommand } from '../cli/define-command';
import { listOperands } from '../cli/dispatch-verb';
import { CommandExitError, UsageError } from '../cli/errors';
import { runAction } from '../cli/run-action';
import type { CliEnv } from '../config/host-store';
import { DEFAULT_SESSION, parseDetachKey } from '../exec/detach-key';
import { createExecIO, runExec } from '../exec/exec-client';
import { listSavedTargets, runOnHosts } from '../hosts/fan-out';
import type { StartTimer } from '../hosts/fan-out';
import { formatHostImps } from '../output/format-host-imps';
import { formatImp } from '../output/format-imp';
import { formatImps } from '../output/format-imps';
import { formatJson, formatOutput } from '../output/format-output';
import { printTrustWarnings } from '../output/print-trust-warnings';
import { parseDuration } from '../parse/parse-duration';
import { formatPolicy, parsePolicy } from '../parse/parse-policy';
import { readTermEnv } from '../sessions/read-term-env';

const PARTIAL_CODE = 3;

export const lsCommand = defineCommand({
  name: 'ls',
  description: 'List imps',
  args: {
    all: { type: 'boolean', description: 'list the imps on every saved host (see impz host ls)' },
    builders: {
      type: 'boolean',
      description: 'list the image builders impd runs for builds too',
    },
    json: jsonArg,
  },
  run: async (ctx) => {
    if (ctx.values.all !== true) {
      await runAction(ctx.extensions.impz, async (client) => {
        const input = ctx.values.builders === true ? { builders: true } : undefined;

        const imps = await client.imps.list(input);

        ctx.extensions.impz.io.print(formatOutput(imps, ctx.values.json, formatImps));
      });

      return;
    }

    const io = ctx.extensions.impz.io;

    if (ctx.extensions.impz.host !== null) {
      throw new UsageError('--all lists every saved host; drop --host');
    }

    const code = await listAllImps({
      env: io.env,
      isJson: ctx.values.json === true,
      hasBuilders: ctx.values.builders === true,
      print: io.print,
      printError: io.printError,
    });

    if (code !== 0) {
      throw new CommandExitError(code);
    }
  },
});

interface AllImpsRun {
  readonly env: CliEnv;
  readonly isJson: boolean;
  readonly hasBuilders: boolean;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly startTimer?: StartTimer;
}

export async function listAllImps(run: Readonly<AllImpsRun>): Promise<number> {
  const input = run.hasBuilders ? { builders: true } : undefined;

  const answers = await runOnHosts(
    listSavedTargets(run.env, run.printError),
    (client, signal) => client.imps.list(input, { signal }),
    undefined,
    run.startTimer,
  );

  const imps = answers.flatMap((answer) =>
    'value' in answer ? answer.value.map((imp) => ({ ...imp, host: answer.host })) : [],
  );

  const errors = answers.flatMap((answer) =>
    'error' in answer ? [{ host: answer.host, message: answer.error }] : [],
  );

  const output = run.isJson ? formatJson({ imps, errors }) : formatHostImps(imps);

  run.print(output);

  for (const error of errors) {
    run.printError(`impz: ${error.host}: ${error.message}`);
  }

  if (errors.length === 0) {
    return 0;
  }

  return errors.length === answers.length ? 1 : PARTIAL_CODE;
}

export const startCommand = defineCommand({
  name: 'start',
  description: 'Boot a stopped imp',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.start({ name: ctx.values.name });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const stopCommand = defineCommand({
  name: 'stop',
  description: 'Shut an imp down (its disk stays, its memory and leases do not)',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      // a person typed it, so the imp's leases end rather than refuse it
      const imp = await client.imps.stop({ name: ctx.values.name, force: true });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const rmCommand = defineCommand({
  name: 'rm',
  description: 'Destroy an imp and its disk and checkpoints',
  args: { name: nameArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.imps.destroy({ name: ctx.values.name });
    }),
});

export const sleepCommand = defineCommand({
  name: 'sleep',
  description: 'Snapshot an imp to disk and free its RAM, ending its leases',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      // a person typed it, so the imp's leases end rather than refuse it
      const imp = await client.imps.sleep({ name: ctx.values.name, force: true });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const wakeCommand = defineCommand({
  name: 'wake',
  description: 'Resume a sleeping or stopped imp',
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.wake({ name: ctx.values.name });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const holdCommand = defineCommand({
  name: 'hold',
  description: 'Keep an imp awake for a while (0 releases)',
  args: {
    name: nameArg,
    duration: { type: 'positional', description: 'e.g. 90s, 15m, 2h', required: true },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.hold({
        name: ctx.values.name,
        seconds: parseDuration(ctx.values.duration),
      });

      ctx.extensions.impz.io.print(
        `${imp.name} held until ${imp.holdUntil?.toISOString() ?? 'released'}`,
      );
    }),
});

export const urlCommand = defineCommand({
  name: 'url',
  description:
    "Print an imp's URLs: https first when HTTPS is on, then its tailnet name, local and tailnet",
  args: { name: nameArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const urls = await client.imps.url({ name: ctx.values.name });

      if (urls.https !== null) {
        ctx.extensions.impz.io.print(urls.https);
      }

      if (urls.public !== null && urls.public !== urls.https) {
        ctx.extensions.impz.io.print(urls.public);
      }

      if (urls.service !== null) {
        ctx.extensions.impz.io.print(urls.service);
      }

      ctx.extensions.impz.io.print(urls.local);

      if (urls.tailnet !== null) {
        ctx.extensions.impz.io.print(urls.tailnet);
      }
    }),
});

export const policyCommand = defineCommand({
  name: 'policy',
  description: "Show or set an imp's egress policy: open, public, box with --allow, or none",
  args: {
    name: nameArg,
    mode: { type: 'positional', description: 'open, public, box or none', required: false },
    allow: {
      type: 'string',
      description: 'what a box may reach: hosts, *.domains, IP addresses or CIDRs, comma-separated',
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const policy = parsePolicy(ctx.values.mode, ctx.values.allow);

      if (policy !== undefined && EGRESS_MODE_TRAITS[policy.mode].isPublic) {
        await requireFeatures(client, { publicEgress: 'refuse the public egress policy' });
      }

      const current =
        policy === undefined
          ? await client.imps.policy({ name: ctx.values.name })
          : await client.imps.setPolicy({ name: ctx.values.name, policy });

      ctx.extensions.impz.io.print(formatOutput(current, ctx.values.json, formatPolicy));

      if (policy !== undefined) {
        await printTrustWarnings(client, ctx.extensions.impz.io, ctx.values.name);
      }
    }),
});

export function listForkWarnings(
  source: string,
  fork: Readonly<Pick<ForkResult, 'name' | 'grantsNotCopied' | 'grantsError'>>,
): string[] {
  const skipped = (fork.grantsNotCopied ?? []).map(
    (each) => `${fork.name}: grant ${each.secret} of ${source} not copied: ${each.reason}`,
  );

  return fork.grantsError === undefined
    ? skipped
    : [...skipped, `${fork.name}: ${fork.grantsError}`];
}

export const forkCommand = defineCommand({
  name: 'fork',
  description: "Create an imp from another imp's disk or checkpoint",
  args: {
    source: { type: 'positional', description: 'imp to fork', required: true },
    name: { type: 'positional', description: 'name of the new imp', required: true },
    from: { type: 'string', description: 'checkpoint id or label (default: the live disk)' },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.fork({
        source: ctx.values.source,
        name: ctx.values.name,
        ...(ctx.values.from !== undefined && { checkpoint: ctx.values.from }),
      });

      // the fork exists either way, so these warn and the exit stays 0
      for (const warning of listForkWarnings(ctx.values.source, imp)) {
        ctx.extensions.impz.io.printError(`impz: ${warning}`);
      }

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const execCommand = defineCommand({
  name: 'exec',
  description: 'Run a command in an imp (impz exec [-t] <name> -- cmd args)',
  args: {
    name: nameArg,
    tty: { type: 'boolean', short: 't', description: 'run on a terminal' },
    agent: {
      type: 'boolean',
      description:
        "run as root in the imp's agent, outside its container, with busybox (host-wide manage scope)",
    },
    require: {
      type: 'custom',
      parse: parseRequire,
      conflicts: 'agent',
      description:
        'start the command only if impd can ensure these, or fail and run nothing: broker (comma-separated)',
    },
  },
  run: async (ctx) => {
    const argv = ctx._.includes('--') ? ctx.rest : listOperands(ctx).slice(1);

    if (argv.length === 0) {
      throw new UsageError('exec needs a command: impz exec <name> -- cmd args');
    }

    const code = await runExec(
      {
        host: ctx.extensions.impz.host,
        name: ctx.values.name,
        argv,
        tty: ctx.values.tty === true,
        ...(ctx.values.tty === true && { env: readTermEnv(ctx.extensions.impz.io.env) }),
        ...(ctx.values.agent === true && { outer: true }),
        ...(ctx.values.require !== undefined && { require: ctx.values.require }),
      },
      createExecIO(ctx.extensions.impz.io),
    );

    throw new CommandExitError(code, true);
  },
});

function parseRequire(text: string): ExecRequirement[] {
  const names = text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  const known = new Set<string>(EXEC_REQUIREMENTS);

  const bad = names.find((name) => !known.has(name));

  if (names.length === 0 || bad !== undefined) {
    throw new UsageError(`--require takes ${EXEC_REQUIREMENTS.join(', ')}; not ${bad ?? text}`);
  }

  return EXEC_REQUIREMENTS.filter((name) => names.includes(name));
}

export const consoleCommand = defineCommand({
  name: 'console',
  description: 'Open a shell in an imp, in a session that outlives the terminal (ctrl-] detaches)',
  args: {
    name: nameArg,
    session: {
      type: 'string',
      description: `session to start or attach to (default ${DEFAULT_SESSION} on a terminal); --no-session for a shell that ends with the terminal`,
    },
    'no-session': { type: 'boolean', hidden: true },
    log: {
      type: 'boolean',
      description:
        'impd keeps the output of the session this starts, for impz sessions log (docs/guides/session-logs.md)',
    },
    'detach-key': detachKeyArg,
  },
  run: async (ctx) => {
    const impz = ctx.extensions.impz;
    const session = pickConsoleSession(ctx.values, impz.io.isStdinTerminal);
    const detachKey = parseDetachKey(ctx.values['detach-key']);
    const log = ctx.values.log === true;

    if (log && session === null) {
      throw new UsageError('--log needs a session');
    }

    // an older impd would start the session and keep nothing
    if (log) {
      await runAction(impz, (client) =>
        requireFeatures(client, { sessionLog: 'start the session without a log' }),
      );
    }

    const code = await runExec(
      {
        host: impz.host,
        name: ctx.values.name,
        argv: ['/bin/sh', '-c', CONSOLE_SHELL],
        tty: true,
        env: readTermEnv(impz.io.env),
        ...(session !== null && {
          session: { name: session, attachOnly: false, detachKey, log },
        }),
      },
      createExecIO(impz.io),
    );

    throw new CommandExitError(code, true);
  },
});

interface ConsoleSessionArgs {
  readonly session?: string | undefined;
  readonly 'no-session'?: boolean | undefined;
}

export function pickConsoleSession(
  args: Readonly<ConsoleSessionArgs>,
  isTerminal: boolean,
): string | null {
  if (args['no-session'] === true || (args.session === undefined && !isTerminal)) {
    return null;
  }

  return requireSessionName(args.session ?? DEFAULT_SESSION);
}
