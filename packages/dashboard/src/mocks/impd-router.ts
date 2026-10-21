import type {
  Checkpoint,
  Identity,
  Image,
  Imp,
  ImpChangeReason,
  ImpState,
  SshKey,
  SystemInfo,
  Token,
} from '@impz/api';
import { EVENT_VERSION, SYSTEM_FEATURES, impContract, isImpAllowed } from '@impz/api';
import { checkAccess, findAccess } from '@impz/daemon/src/identity/auth/access-policy';
import { readChangedImps } from '@impz/daemon/src/identity/auth/builder-calls';
import type { Caller } from '@impz/daemon/src/identity/auth/caller';
import { toLeaseSummary } from '@impz/daemon/src/identity/auth/caller-view';
import { deriveImageName } from '@impz/daemon/src/imps/images/image-naming';
import { resolveCpuSettings } from '@impz/daemon/src/imps/imps/cpu-limit';
import { requireTransition } from '@impz/daemon/src/imps/imps/imp-transitions';
import { formatKeyFingerprint, parsePublicKey } from '@impz/daemon/src/imps/ssh/authorized-keys';
import {
  buildBuilderError,
  buildConflictError,
  buildForbiddenError,
  buildInvalidStateError,
  buildNotFoundError,
} from '@impz/daemon/src/surface/api-errors';
import { ORPCError, implement } from '@orpc/server';
import { checkpointCollection } from './db/checkpoint-collection';
import { hostCollection } from './db/host-collection';
import { imageCollection } from './db/image-collection';
import { impCollection } from './db/imp-collection';
import { impPolicyCollection } from './db/imp-policy-collection';
import { secretCollection } from './db/secret-collection';
import { tokenCollection } from './db/token-collection';
import { emitImpdEvent, openImpdEventStream } from './impd-events';

export interface ImpdSession extends Identity {
  readonly expiresAt: Date;
}

interface ImpdRouterContext {
  readonly session: ImpdSession;
}

const MIB = 1024 * 1024;
const ROOT_NAME = 'root';

const os = implement(impContract)
  .$context<ImpdRouterContext>()
  .use(async (options, input) => {
    const procedure = options.path.join('.');
    const access = findAccess(procedure);

    const refusal = await checkAccess(access, toCaller(options.context.session), input, () =>
      Promise.resolve(null),
    );

    if (refusal !== null) {
      throw buildForbiddenError(refusal.message, refusal.reason);
    }

    for (const name of readChangedImps(procedure, access, input)) {
      if (impCollection.findFirst((query) => query.where({ name }))?.kind === 'builder') {
        throw buildBuilderError(name);
      }
    }

    return options.next();
  });

export const impdRouter = {
  imps: {
    create: os.imps.create.handler(async (options) => {
      const input = options.input;

      const host = await readHost();

      const image =
        input.image === undefined ? requireDefaultImage(host.defaultImage) : findImage(input.image);

      if (input.name !== undefined) {
        requireFreeImpName(input.name);
      }

      const cpu = resolveCpuSettings(input, null, host.cpu.hostCpus);

      const imp = await impCollection.create({
        ...(input.name !== undefined && { name: input.name }),
        image: image.name,
        state: 'creating',
        vcpus: input.vcpus ?? host.defaultVcpus,
        memoryMib: input.memoryMib ?? host.defaultMemoryMib,
        ...(input.maxMemoryMib !== undefined && { maxMemoryMib: input.maxMemoryMib }),
        ...(input.diskMib !== undefined && { diskMib: input.diskMib }),
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
        ...(input.backup === false && { backup: false }),
        cpu,
      });

      await impPolicyCollection.create({
        imp: imp.name,
        ...(input.policy !== undefined && { policy: input.policy }),
      });

      const booted = await emitImpCreation(imp);

      return toCallerImp(options.context.session, booted);
    }),

    list: os.imps.list.handler((options) =>
      listImps()
        .filter((imp) => isImpAllowed(options.context.session.imps, imp.name))
        .filter((imp) => options.input?.builders === true || imp.kind !== 'builder')
        .map((imp) => toCallerImp(options.context.session, imp)),
    ),
    get: os.imps.get.handler((options) =>
      toCallerImp(options.context.session, findImp(options.input.name)),
    ),
    destroy: os.imps.destroy.handler((options) => {
      const imp = findImp(options.input.name);

      impCollection.delete((query) => query.where({ name: imp.name }));
      impPolicyCollection.deleteMany((query) => query.where({ imp: imp.name }));
      checkpointCollection.deleteMany((query) => query.where({ imp: imp.name }));

      emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpRemoved', imp });

      return {};
    }),
    start: os.imps.start.handler(async (options) => {
      const started = await requireRunningImp(options.input.name);

      return toCallerImp(options.context.session, started);
    }),

    stop: os.imps.stop.handler(async (options) => {
      const imp = findImp(options.input.name);

      if (imp.state === 'creating') {
        throw buildInvalidStateError(imp.state, ['running', 'sleeping', 'error'], 'stop');
      }

      const stopped = await writeImpState(imp.name, 'stopped', 'stop', 'stopped');

      return toCallerImp(options.context.session, stopped);
    }),
    sleep: os.imps.sleep.handler(async (options) => {
      const slept = await writeImpState(options.input.name, 'sleeping', 'sleep', 'slept');

      return toCallerImp(options.context.session, slept);
    }),

    wake: os.imps.wake.handler(async (options) => {
      const imp = findImp(options.input.name);

      if (imp.state === 'error' && options.input.restartError === false) {
        throw buildInvalidStateError(imp.state, ['running', 'sleeping', 'stopped'], 'wake');
      }

      const woken = await requireRunningImp(imp.name);

      return toCallerImp(options.context.session, woken);
    }),
    url: os.imps.url.handler((options) => ({
      local: findImp(options.input.name).url,
      https: null,
      public: null,
      service: null,
      tailnet: null,
    })),

    update: os.imps.update.handler(async (options) => {
      const input = options.input;
      const imp = findImp(input.name);
      const vcpus = input.vcpus ?? imp.vcpus;

      if (vcpus !== imp.vcpus && imp.state !== 'stopped') {
        throw buildInvalidStateError(imp.state, ['stopped'], 'change the vCPU count of');
      }

      const host = await readHost();

      const cpu = resolveCpuSettings(input, imp.cpu ?? null, host.cpu.hostCpus);

      const updated = await updateImp(input.name, 'updated', {
        cpu,
        vcpus,
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
      });

      return toCallerImp(options.context.session, updated);
    }),

    fork: os.imps.fork.handler(async (options) => {
      const input = options.input;
      const source = findImp(input.source);

      const checkpoint =
        input.checkpoint === undefined ? null : findCheckpoint(source.name, input.checkpoint);

      if (checkpoint === null && source.state === 'creating') {
        throw buildInvalidStateError(
          source.state,
          ['running', 'sleeping', 'stopped', 'error'],
          'fork',
        );
      }

      requireFreeImpName(input.name);

      const imp = await impCollection.create({
        name: input.name,
        image: source.image,
        state: 'creating',
        vcpus: source.vcpus,
        memoryMib: source.memoryMib,
        ...(source.maxMemoryMib !== undefined && { maxMemoryMib: source.maxMemoryMib }),
        diskMib: checkpoint?.diskMib ?? source.diskMib,
        ...(source.cpu !== undefined && { cpu: source.cpu }),
      });

      const policy = impPolicyCollection.findFirst((query) => query.where({ imp: source.name }));

      await impPolicyCollection.create({
        imp: imp.name,
        ...(policy !== undefined && { policy: policy.policy }),
      });

      const booted = await emitImpCreation(imp);

      return { ...toCallerImp(options.context.session, booted), grantsNotCopied: [] };
    }),
  },
  checkpoints: {
    create: os.checkpoints.create.handler(async (options) => {
      const imp = findImp(options.input.name);
      const label = options.input.label;

      if (label !== undefined) {
        if (label.startsWith('cp-')) {
          throw new ORPCError('BAD_REQUEST', { message: 'a label must not start with cp-' });
        }

        if (findCheckpointRow(imp.name, label) !== undefined) {
          throw buildConflictError('checkpoint', label);
        }
      }

      const row = await checkpointCollection.create({
        imp: imp.name,
        createdAt: new Date(),
        diskMib: imp.diskMib,
        ...(label !== undefined && { label }),
      });

      const checkpoint = toCheckpoint(row);

      emitImpdEvent({
        v: EVENT_VERSION,
        at: new Date(),
        ev: 'CheckpointAdded',
        name: imp.name,
        checkpoint,
      });

      return checkpoint;
    }),

    list: os.checkpoints.list.handler((options) => {
      const imp = findImp(options.input.name);

      return checkpointCollection
        .findMany((query) => query.where({ imp: imp.name }))
        .toSorted(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            readTextOrder(right.id, left.id),
        )
        .map((row) => toCheckpoint(row));
    }),

    restore: os.checkpoints.restore.handler(async (options) => {
      const imp = findImp(options.input.name);
      const checkpoint = findCheckpoint(imp.name, options.input.checkpoint);

      if (imp.state === 'creating') {
        throw buildInvalidStateError(
          imp.state,
          ['running', 'sleeping', 'stopped', 'error'],
          'restore',
        );
      }

      const isAwake = imp.state === 'running' || imp.state === 'sleeping';

      const restored = await updateImp(imp.name, 'restored', {
        diskMib: checkpoint.diskMib,
        ...(isAwake && { state: 'running' }),
      });

      return toCallerImp(options.context.session, restored);
    }),
    delete: os.checkpoints.delete.handler((options) => {
      const imp = findImp(options.input.name);
      const checkpoint = findCheckpoint(imp.name, options.input.checkpoint);

      checkpointCollection.delete((query) => query.where({ imp: imp.name, id: checkpoint.id }));

      emitImpdEvent({
        v: EVENT_VERSION,
        at: new Date(),
        ev: 'CheckpointRemoved',
        name: imp.name,
        checkpoint,
      });

      return {};
    }),
  },
  images: {
    list: os.images.list.handler(() => imageCollection.findMany()),
    add: os.images.add.handler((options) => {
      const input = options.input;

      return 'imp' in input
        ? writeTemplate(input.name, findImp(input.imp))
        : writeDockerImage(input.name ?? deriveImageName(input.ref), input.ref);
    }),

    delete: os.images.delete.handler((options) => {
      const image = findImage(options.input.name);
      const users = impCollection.findMany((query) => query.where({ image: image.name })).length;

      if (users > 0) {
        throw buildConflictError(
          'image',
          image.name,
          `image ${image.name} is used by ${String(users)} imp(s)`,
        );
      }

      imageCollection.delete((query) => query.where({ name: image.name }));

      return {};
    }),
  },
  events: {
    stream: os.events.stream.handler((options) =>
      openImpdEventStream(options.context.session, () => listImps(), options.signal),
    ),
  },
  system: {
    info: os.system.info.handler(() => readSystemInfo()),
  },
  tokens: {
    list: os.tokens.list.handler(() =>
      tokenCollection
        .findMany()
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((row) => toToken(row)),
    ),

    create: os.tokens.create.handler(async (options) => {
      const input = options.input;

      if (input.name === ROOT_NAME || readToken(input.name) !== undefined) {
        throw buildConflictError('token', input.name);
      }

      const imps = input.imps ?? null;
      const sshKeys = requireDistinctKeys((input.sshKeys ?? []).map((line) => readSshKey(line)));
      const grantable = readGrantable(input.grantable ?? [], { scope: input.scope, imps });
      const imageRefPrefix = input.imageRefPrefix ?? null;

      requireImageScope(imageRefPrefix, { scope: input.scope, imps });

      const row = await tokenCollection.create({
        name: input.name,
        scope: input.scope,
        imps,
        ...(sshKeys.length > 0 && { sshKeys }),
        ...(grantable.length > 0 && { grantable }),
        imageRefPrefix,
        createdAt: new Date(),
      });

      return { token: toToken(row), secret: row.secret };
    }),
    update: os.tokens.update.handler(async (options) => {
      const token = readToken(options.input.name);

      if (token === undefined) {
        throw buildNotFoundError('token', options.input.name);
      }

      const input = options.input;

      const grantable =
        input.grantable === undefined ? token.grantable : readGrantable(input.grantable, token);

      const imageRefPrefix =
        input.imageRefPrefix === undefined ? token.imageRefPrefix : input.imageRefPrefix;

      requireImageScope(imageRefPrefix, token);

      const updated = await tokenCollection.update((query) => query.where({ name: token.name }), {
        data(row) {
          row.grantable = [...grantable];
          row.imageRefPrefix = imageRefPrefix;
        },
      });

      if (updated === undefined) {
        throw buildNotFoundError('token', token.name);
      }

      return toToken(updated);
    }),
    delete: os.tokens.delete.handler((options) => {
      const token = readToken(options.input.name);

      if (token === undefined) {
        throw buildNotFoundError('token', options.input.name);
      }

      tokenCollection.delete((query) => query.where({ name: token.name }));

      return {};
    }),
    whoami: os.tokens.whoami.handler((options) => toIdentity(options.context.session)),
  },
};

function toCaller(session: Readonly<ImpdSession>): Caller {
  return {
    kind: session.kind,
    name: session.name,
    scope: session.scope,
    imps: session.imps,
    grantable: session.grantable.map((name) => ({ name, generation: '1' })),
    imageRefPrefix: session.imageRefPrefix,
    tokenId: session.name,
    grantId: null,
    expiresAt: session.expiresAt.getTime(),
    principal: session.name,
    display: session.name,
  };
}

async function readHost() {
  const host = hostCollection.findFirst();

  if (host !== undefined) {
    return host;
  }

  const created = await hostCollection.create({});

  return created;
}

function requireDefaultImage(configured: string): Image {
  const image = findDefaultImage(configured);

  if (image === undefined) {
    throw buildNotFoundError('image', configured);
  }

  return image;
}

function findDefaultImage(configured: string): Image | undefined {
  return [configured, FALLBACK_DEFAULT_IMAGE]
    .map((name) => imageCollection.findFirst((query) => query.where({ name })))
    .find((image) => image !== undefined);
}

function findImage(name: string): Image {
  const image = imageCollection.findFirst((query) => query.where({ name }));

  if (image === undefined) {
    throw buildNotFoundError('image', name);
  }

  return image;
}

// copied from impd, whose module for it pulls Bun-only types into the
// dashboard's DOM typecheck
const FALLBACK_DEFAULT_IMAGE = 'ubuntu';

function requireFreeImpName(name: string): void {
  if (impCollection.findFirst((query) => query.where({ name })) !== undefined) {
    throw buildConflictError('imp', name);
  }
}

function emitImpCreation(imp: Imp): Promise<Imp> {
  emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpAdded', reason: 'created', imp });

  return updateImp(imp.name, 'booted', { state: 'running' });
}

async function updateImp(name: string, reason: ImpChangeReason, change: Partial<Imp>) {
  const imp = await impCollection.update((query) => query.where({ name }), {
    data(record) {
      Object.assign(record, change);
    },
  });

  if (imp === undefined) {
    throw buildNotFoundError('imp', name);
  }

  emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpChanged', reason, imp });

  return imp;
}

function toCallerImp(session: Readonly<ImpdSession>, imp: Imp): Imp {
  return { ...imp, leases: toLeaseSummary(toCaller(session), imp.name, []) };
}

function listImps(): Imp[] {
  return impCollection.findMany().toSorted((left, right) => readTextOrder(left.name, right.name));
}

function readTextOrder(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function findImp(name: string): Imp {
  const imp = impCollection.findFirst((query) => query.where({ name }));

  if (imp === undefined) {
    throw buildNotFoundError('imp', name);
  }

  return imp;
}

function requireRunningImp(name: string) {
  const imp = findImp(name);

  if (imp.state === 'running') {
    return Promise.resolve(imp);
  }

  if (imp.state === 'sleeping') {
    return updateImp(name, 'woke', { state: 'running' });
  }

  requireTransition(imp.state, 'running', 'start');

  return updateImp(name, 'booted', { state: 'running' });
}

function writeImpState(name: string, to: ImpState, action: string, reason: ImpChangeReason) {
  const imp = findImp(name);

  if (imp.state === to) {
    return Promise.resolve(imp);
  }

  requireTransition(imp.state, to, action);

  return updateImp(name, reason, { state: to });
}

function findCheckpoint(imp: string, ref: string): Checkpoint {
  const row = findCheckpointRow(imp, ref);

  if (row === undefined) {
    throw buildNotFoundError('checkpoint', ref);
  }

  return toCheckpoint(row);
}

function findCheckpointRow(imp: string, ref: string) {
  return (
    checkpointCollection.findFirst((query) => query.where({ imp, id: ref })) ??
    checkpointCollection.findFirst((query) => query.where({ imp, label: ref }))
  );
}

function toCheckpoint(row: Readonly<Checkpoint & { readonly imp: string }>): Checkpoint {
  const { imp: _imp, ...checkpoint } = row;

  return checkpoint;
}

function writeTemplate(name: string, imp: Imp): Promise<Image> {
  const existing = imageCollection.findFirst((query) => query.where({ name }));

  if (existing?.source === 'oci') {
    throw buildConflictError(
      'image',
      name,
      `image ${name} is a docker image; give the template a name of its own`,
    );
  }

  return writeImageRow(name, { ref: `imp:${imp.name}`, source: 'imp' });
}

async function writeImageRow(
  name: string,
  made: Pick<Image, 'ref'> & Partial<Pick<Image, 'source'>>,
): Promise<Image> {
  const updated = await imageCollection.update((query) => query.where({ name }), {
    data(row) {
      Object.assign(row, made);
    },
  });

  return updated ?? imageCollection.create({ name, ...made });
}

function writeDockerImage(name: string, ref: string): Promise<Image> {
  const existing = imageCollection.findFirst((query) => query.where({ name }));

  if (existing?.source === 'imp') {
    throw buildConflictError(
      'image',
      name,
      `image ${name} is a template; make it again from an imp, or pick another name`,
    );
  }

  return writeImageRow(name, { ref });
}

async function readSystemInfo(): Promise<SystemInfo> {
  const host = await readHost();

  const imps = listImps();
  const running = imps.filter((imp) => imp.state === 'running');
  const sleeping = imps.filter((imp) => imp.state === 'sleeping');
  const defaultImage = findDefaultImage(host.defaultImage);

  return {
    version: host.version,
    ramBudgetMib: host.ramBudgetMib,
    ramUsedMib: running.reduce((sum, imp) => sum + (imp.ramMib ?? 0), 0),
    ramReservedMib: host.ramReservedMib,
    ramCommittedMib: running.reduce((sum, imp) => sum + (imp.maxMemoryMib ?? imp.memoryMib), 0),
    ramSleepingMib: sleeping.reduce((sum, imp) => sum + imp.memoryMib, 0),
    awakeCount: running.length,
    impCount: imps.length,
    sessionCount: imps.reduce((sum, imp) => sum + (imp.sessions ?? 0), 0),
    bootStatus: countBootStatuses(imps),
    firecrackerVersion: host.firecrackerVersion,
    guestKernel: host.guestKernel,
    systemDrive: host.systemDrive,
    guest: { scratchDir: '/tmp', isClearedOnBoot: false },
    storage: {
      backend: host.backend,
      ...host.disk,
      impDiskBytes: imps.reduce((sum, imp) => sum + imp.diskMib * MIB, 0),
    },
    tailscale: host.tailscale,
    cpu: host.cpu,
    rebootReason: host.rebootReason,
    defaults: { memoryMib: host.defaultMemoryMib, image: defaultImage?.name ?? null },
    egress: { isEnforced: host.isEgressEnforced },
    ksm: host.ksm === null ? null : { ...host.ksm, unmergeable: 0 },
    public:
      host.publicIp === null
        ? null
        : {
            ip: host.publicIp,
            imps: imps.filter((imp) => imp.public !== undefined).length,
            records: host.publicRecords,
          },
    https: host.https,
    features: SYSTEM_FEATURES,
  };
}

// copied from impd, whose module for it imports modules the browser cannot
// load
function countBootStatuses(imps: readonly Imp[]): SystemInfo['bootStatus'] {
  const outdated = { firecracker: 0, kernel: 0, agent: 0 };
  const awake = imps.filter((imp) => imp.state === 'running' || imp.state === 'sleeping');
  let noIpv6 = 0;

  for (const imp of awake) {
    for (const part of imp.outdated ?? []) {
      if (part === 'ipv6') {
        noIpv6 += 1;
      } else if (part !== 'impd') {
        outdated[part] += 1;
      }
    }
  }

  const coldBoots = awake.filter((imp) => {
    const parts = imp.outdated ?? [];

    return imp.state === 'sleeping'
      ? imp.coldBootReason !== undefined
      : parts.includes('firecracker') || parts.includes('impd');
  }).length;

  return { coldBoots, outdated: noIpv6 === 0 ? outdated : { ...outdated, ipv6: noIpv6 } };
}

function toToken(row: Readonly<Token & { readonly secret: string }>): Token {
  const { secret: _secret, ...token } = row;

  return token;
}

function readToken(name: string) {
  return tokenCollection.findFirst((query) => query.where({ name }));
}

function requireDistinctKeys(keys: readonly SshKey[]): SshKey[] {
  const seen = new Set<string>();

  for (const key of keys) {
    if (seen.has(key.fingerprint)) {
      throw buildConflictError('ssh-key', key.fingerprint, 'the same key is given twice');
    }

    seen.add(key.fingerprint);
  }

  return [...keys];
}

function readSshKey(line: string): SshKey {
  const key = parsePublicKey(line);

  if (typeof key === 'string') {
    throw new ORPCError('BAD_REQUEST', { message: `not an SSH public key: ${key}` });
  }

  const fingerprint = formatKeyFingerprint(key.blob);

  const isBound = tokenCollection
    .findMany()
    .some((token) => token.sshKeys.some((bound) => bound.fingerprint === fingerprint));

  if (isBound) {
    throw buildConflictError('ssh-key', fingerprint, `key ${fingerprint} is bound to a token`);
  }

  return { fingerprint, type: key.type, comment: key.comment };
}

function readGrantable(
  names: readonly string[],
  token: Readonly<Pick<Token, 'scope' | 'imps'>>,
): string[] {
  if (names.length === 0) {
    return [];
  }

  if (token.imps === null || token.scope !== 'manage') {
    throw new ORPCError('BAD_REQUEST', {
      message: 'a token that may grant secrets needs scope manage and imp patterns',
    });
  }

  return names.map((name) => {
    if (secretCollection.findFirst((query) => query.where({ name })) === undefined) {
      throw buildNotFoundError('secret', name);
    }

    return name;
  });
}

function requireImageScope(
  imageRefPrefix: string | null,
  token: Readonly<Pick<Token, 'scope' | 'imps'>>,
): void {
  if (imageRefPrefix !== null && (token.imps === null || token.scope !== 'manage')) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'a token that may add images needs scope manage and imp patterns',
    });
  }
}

function toIdentity(session: Readonly<ImpdSession>): Identity {
  const { expiresAt: _expiresAt, ...identity } = session;

  return identity;
}
