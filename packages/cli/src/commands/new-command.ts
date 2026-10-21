import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { ExposeResult, Imp } from '@impz/api';
import { requireFeatures } from '@impz/client';
import { authArgs } from '../args/auth-args';
import { jsonArg } from '../args/common-args';
import { cpuLimitArg, cpuWeightArg, readCpuArgs } from '../args/cpu-args';
import type { CommandIO } from '../cli/command-io';
import { defineCommand } from '../cli/define-command';
import { UsageError } from '../cli/errors';
import { formatError, runAction, toCallError } from '../cli/run-action';
import type { CliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import type { ImpClient } from '../config/create-imp-client';
import { listSavedTargets, runOnHosts } from '../hosts/fan-out';
import type { SavedTarget } from '../hosts/fan-out';
import { buildRanking, createPlaced, readHostProbe } from '../hosts/place-imp';
import type { PlaceRequest } from '../hosts/place-imp';
import { formatExposeResult } from '../output/format-expose-result';
import { formatImp } from '../output/format-imp';
import { formatJson } from '../output/format-output';
import { printTrustWarnings } from '../output/print-trust-warnings';
import { parsePolicy } from '../parse/parse-policy';
import { parsePublicAuth } from '../parse/parse-public-auth';
import { parseCount, parseSize } from '../parse/parse-size';

export const newCommand = defineCommand({
  name: 'new',
  description: 'Create an imp and boot it',
  args: {
    name: {
      type: 'positional',
      description: 'imp name (generated when left out)',
      required: false,
    },
    image: { type: 'string', description: 'image name' },
    cpus: { type: 'string', description: 'vCPU count' },
    memory: { type: 'string', description: 'memory: MiB, or with a unit (512m, 2g)' },
    'max-memory': {
      type: 'string',
      description: 'what the guest may grow to under pressure, at most 4 × memory',
    },
    disk: { type: 'string', description: 'disk size, with a unit (64g); 32g by default' },
    'http-port': { type: 'string', description: 'guest port the proxy forwards to (default 8080)' },
    policy: {
      type: 'string',
      description: 'egress policy: open (default), public (the internet only), box or none',
    },
    allow: {
      type: 'string',
      description: 'what a box may reach: hosts, *.domains, IP addresses or CIDRs, comma-separated',
    },
    'cpu-limit': cpuLimitArg,
    'cpu-weight': cpuWeightArg,
    public: { type: 'boolean', description: 'serve it to the internet too, as impz expose does' },
    ...authArgs,
    net: { type: 'string', description: 'networks to join, comma-separated (see impz net)' },
    backup: {
      type: 'boolean',
      negatable: true,
      default: true,
      description: 'hold the imp in the host’s backups (the default)',
      negativeDescription: 'leave its disk and checkpoints out of every backup, for its life',
    },
    place: {
      type: 'boolean',
      description: 'create it on the saved host with the most free RAM (see impz host ls)',
    },
    json: jsonArg,
  },
  run: async (ctx) => {
    const io = ctx.extensions.impz.io;
    const request = readNewRequest(ctx.values);

    if (ctx.values.place !== true) {
      await runAction(ctx.extensions.impz, (client) => runNew(client, io, request, null));

      return;
    }

    if (ctx.extensions.impz.host !== null) {
      throw new UsageError('--place picks among the saved hosts; drop --host');
    }

    await runPlacedNew(io, request);
  },
});

type CreateInput = Readonly<Omit<Parameters<ImpClient['imps']['create']>[0], 'networks'>> & {
  readonly networks?: readonly string[];
};

type ExposeAuth = ReturnType<typeof parsePublicAuth>;

interface NewRequest {
  readonly input: CreateInput;
  readonly auth: ExposeAuth | null;
  readonly json: boolean;
}

interface NewArgs extends Readonly<Record<string, unknown>> {
  readonly name?: string | undefined;
  readonly image?: string | undefined;
  readonly cpus?: string | undefined;
  readonly memory?: string | undefined;
  readonly 'max-memory'?: string | undefined;
  readonly disk?: string | undefined;
  readonly 'http-port'?: string | undefined;
  readonly policy?: string | undefined;
  readonly allow?: string | undefined;
  readonly 'cpu-limit'?: string | undefined;
  readonly 'cpu-weight'?: string | undefined;
  readonly public?: boolean | undefined;
  readonly auth?: string | undefined;
  readonly user?: string | undefined;
  readonly net?: string | undefined;
  readonly backup?: boolean | undefined;
  readonly json?: boolean | undefined;
}

// every flag checked before any call, so a bad one leaves no imp behind
function readNewRequest(args: NewArgs): NewRequest {
  const policy = parsePolicy(args.policy, args.allow);
  const networks = args.net?.split(',').map((network) => network.trim());
  const isPublic = args.public === true;

  if (!isPublic && (args.auth !== undefined || args.user !== undefined)) {
    throw new UsageError('--auth and --user need --public');
  }

  const input: CreateInput = {
    ...(args.name !== undefined && { name: args.name }),
    ...(args.image !== undefined && { image: args.image }),
    ...(args.cpus !== undefined && { vcpus: parseCount(args.cpus, 'cpus') }),
    ...(args.memory !== undefined && { memoryMib: parseSize(args.memory) }),
    ...(args['max-memory'] !== undefined && { maxMemoryMib: parseSize(args['max-memory']) }),
    ...(args.disk !== undefined && { diskMib: parseSize(args.disk) }),
    ...(args['http-port'] !== undefined && {
      httpPort: parseCount(args['http-port'], 'http-port'),
    }),
    ...(policy !== undefined && { policy }),
    ...readCpuArgs(args),
    ...(networks !== undefined && { networks }),
    ...(args.backup === false && { backup: false }),
  };

  return {
    input,
    auth: isPublic ? parsePublicAuth(args.auth, args.user) : null,
    json: args.json === true,
  };
}

async function runNew(
  client: ImpClient,
  io: CommandIO,
  request: NewRequest,
  placed: SavedTarget | null,
) {
  const input = request.input;
  const auth = request.auth;
  const host = placed?.host ?? null;

  // expose needs manage on the host, and impd checks it again on the call;
  // placement already checked it on every host it ranked
  if (auth !== null && placed === null) {
    const identity = await client.tokens.whoami();

    if (identity.scope !== 'manage' || identity.imps !== null) {
      // a refusal, as impd's own would be: exit 1, not a usage error
      throw new Error('--public needs a token with manage scope on the host; this one is limited');
    }
  }

  await requireFeatures(client, {
    ...(input.policy !== undefined &&
      EGRESS_MODE_TRAITS[input.policy.mode].isPublic && {
        publicEgress: 'refuse the public egress policy',
      }),
    ...(input.backup === false && { backupOptOut: 'back the imp up anyway' }),
  });

  const { networks, ...fields } = input;

  const imp = await client.imps.create({
    ...fields,
    ...(networks !== undefined && { networks: [...networks] }),
  });

  let exposed: ExposeResult | null = null;

  try {
    if (networks !== undefined) {
      await printTrustWarnings(client, io, imp.name);
    }

    exposed = auth === null ? null : await client.imps.expose({ name: imp.name, ...auth });
  } catch (error) {
    if (placed === null) {
      throw error;
    }

    throw printPlacedFailure(io, imp, placed, error, request.json);
  }

  if (request.json) {
    // the plain create keeps its shape: the imp alone
    const output =
      host === null && exposed === null
        ? imp
        : { ...(host !== null && { host }), imp, ...(exposed !== null && { public: exposed }) };

    io.print(formatJson(output));

    return;
  }

  const text =
    exposed === null ? formatImp(imp) : `${formatImp(imp)}\n${formatExposeResult(exposed)}`;

  io.print(text);
}

// only a stderr line names the host of a placed create, so the error names it
// too; a plain Error, because placement must not try the next host for it
function printPlacedFailure(
  io: CommandIO,
  imp: Imp,
  placed: SavedTarget,
  error: unknown,
  json: boolean,
): Error {
  const message = formatError(error, placed.config);

  if (json) {
    io.print(formatJson({ host: placed.host, imp, error: message }));
  }

  return new Error(`${imp.name} was created on ${placed.host}; ${message}`);
}

async function runPlacedNew(io: CommandIO, request: NewRequest): Promise<void> {
  const targets = listSavedTargets(io.env, io.printError);
  const place = toPlaceRequest(request);

  const answers = await runOnHosts(targets, (client, signal) =>
    readHostProbe(client, signal, place),
  );

  const ranking = buildRanking(answers, place);

  for (const dropped of ranking.dropped) {
    io.printError(`impz: ${dropped.host}: skipped: ${dropped.reason}`);
  }

  if (ranking.ranked.length === 0) {
    throw new Error('no saved host can take the imp');
  }

  let config: CliConfig | null = null;

  try {
    await createPlaced(
      ranking.ranked,
      async (host) => {
        const target = targets.find((saved) => saved.host === host);

        if (target === undefined) {
          throw new Error(`no saved host ${host}`);
        }

        config = target.config;

        io.printError(`impz: placing on ${host}`);

        await runNew(createImpClient(target.config), io, request, target);
      },
      (host, message) => {
        io.printError(`impz: ${host}: ${message}; trying the next host`);
      },
    );
  } catch (error) {
    throw config === null ? error : toCallError(error, config);
  }
}

function toPlaceRequest(request: NewRequest): PlaceRequest {
  const input = request.input;

  return {
    name: input.name ?? null,
    image: input.image ?? null,

    // impd refuses an elastic imp whose max passes its budget
    memoryMib: input.maxMemoryMib ?? input.memoryMib ?? null,
    cpuLimit: input.cpuLimit ?? null,
    policyMode: input.policy?.mode ?? null,
    networks: input.networks ?? [],
    needsWholeHost: request.auth !== null || input.networks !== undefined,
  };
}
