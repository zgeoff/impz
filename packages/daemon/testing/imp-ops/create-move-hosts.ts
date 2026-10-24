import { onTestFinished } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { MoveStatus } from '@impz/api';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { deriveSlotAddress } from '../../src/host-net/net/addressing';
import { readWarmHost } from '../../src/imp-ops/moves/warm-facts';
import { createImage } from '../../src/platform/db/images';
import type { StartTimer } from '../../src/platform/process/clock';
import { buildImagePaths } from '../../src/vm/storage/data-layout';
import { startTestImpd } from '../start-test-impd';
import type { TestImpd, TestImpdOptions } from '../start-test-impd';

// a move needs the target's peer URL to be a literal tailnet address
export const TARGET_URL = 'http://100.100.0.2:7070';
export const SOURCE_PEER = '100.100.0.1';
const SOURCE_URL = 'http://100.100.0.1:7070';
const TARGET_PEER = '100.100.0.2';

interface MoveHookHosts {
  readonly target: Readonly<Pick<TestImpd, 'advance'>>;
  readonly sourceApp: Readonly<Pick<TestImpd, 'client'>>;
}

export type FetchHook = (
  request: Request,
  forward: (replacement?: Request) => Promise<Response>,
  hosts: Readonly<MoveHookHosts>,
) => Promise<Response>;

export interface MoveHostsOptions {
  readonly hook?: FetchHook;
  readonly startPeerDeadline?: StartTimer;
  readonly partBytes?: number;
  readonly readTapMac?: (tap: string) => string | null;

  // Two impds in one process cannot share a data dir as a warm move needs, so both hosts
  // report the target's warm facts and the source's VMs open the target's system drive path.
  readonly isShared?: boolean;
  readonly source?: TestImpdOptions;
  readonly target?: TestImpdOptions;

  // a move on a real pool takes seconds
  readonly moveTimeoutMs?: number;
}

// One stack releases both hosts, because a throw in one onTestFinished callback skips the
// callbacks after it.
export function setupMoveHosts(options: MoveHostsOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return createMoveHosts(stack, options);
}

export async function createMoveHosts(
  stack: Readonly<AsyncDisposableStack>,
  options: MoveHostsOptions = {},
) {
  const commits: string[] = [];
  const back: { source: TestImpd | null } = { source: null };

  const sendToSource = (request: Request): Promise<Response> => {
    invariant(back.source);

    return back.source.moves.respond(request, TARGET_PEER);
  };

  const target = await startTestImpd(stack, {
    ...options.target,
    env: { IMP_PEER_URL: TARGET_URL, ...options.target?.env },
    boundaries: {
      ...options.target?.boundaries,
      moves: {
        fetch: sendToSource,
        ...options.target?.boundaries?.moves,
        onCommitted: (name) => {
          commits.push(name);
        },
      },
    },
  });

  const facts = readWarmHost(target.config, target.readIdentity(), target.storage.kind);
  const shared = options.isShared === true ? { readWarmHost: () => facts } : {};
  const slotPlan = { subnet: target.config.subnet, portBase: 0 };
  const sendToTarget = (request: Request) => target.moves.respond(request, SOURCE_PEER);
  const hook = options.hook;
  const built: { hosts: MoveHookHosts | null } = { hosts: null };

  const runHook = (request: Request, call: FetchHook): Promise<Response> => {
    invariant(built.hosts);

    return call(request, (replacement) => sendToTarget(replacement ?? request), built.hosts);
  };

  const sendSourceRequest = (request: Request) =>
    hook === undefined ? sendToTarget(request) : runHook(request, hook);

  const source = await startTestImpd(stack, {
    ...options.source,
    env: { IMP_PEER_URL: SOURCE_URL, ...options.source?.env },
    boundaries: {
      ...options.source?.boundaries,
      moves: {
        ...shared,
        readTapMac:
          options.readTapMac ??
          ((tap) => deriveSlotAddress(Number(tap.slice('imp'.length)), slotPlan).hostMac),
        fetch: sendSourceRequest,
        ...(options.startPeerDeadline !== undefined && {
          startPeerDeadline: options.startPeerDeadline,
        }),
        ...(options.partBytes !== undefined && { partBytes: options.partBytes }),
      },
    },
  });

  if (options.isShared === true) {
    await source.restartImpd({
      ...source.readIdentity(),
      systemDrivePath: target.readIdentity().systemDrivePath,
    });
  }

  const sourceApp = { client: source.client };
  const targetApp = { client: target.client };

  built.hosts = { target, sourceApp };
  back.source = source;

  const waitForMoveFrom = (from: Readonly<TestImpd>, name: string): Promise<MoveStatus> =>
    waitFor(
      async () => {
        const status = await from.client.moves.status({ name });

        if (!status.isDone && status.error === null) {
          throw new Error(`the move of ${name} never ended`);
        }

        return status;
      },
      { timeoutMs: options.moveTimeoutMs ?? 5000 },
    );

  const waitForMove = (name: string): Promise<MoveStatus> => waitForMoveFrom(source, name);

  // the steps `impz move` runs, where a stop forces as `--stop` does
  const runMoveBetween = async (
    from: Readonly<TestImpd>,
    to: Readonly<TestImpd>,
    name: string,
    stop: boolean,
  ): Promise<MoveStatus> => {
    const info = await to.client.system.info();
    const targetFacts = await to.client.moves.facts();

    const plan = await from.client.moves.prepare({
      name,
      stop,
      ...(stop && { force: true }),
      targetStorage: info.storage.backend,
      target: targetFacts,
    });

    const ticket = await to.client.moves.receive({
      name,
      bytes: plan.bytes,
      ...(plan.warm !== null && { warm: plan.warm }),
    });

    await from.client.moves.send({ name, to: ticket.peerUrl, ticket: ticket.ticket });

    return waitForMoveFrom(from, name);
  };

  const runMove = (name: string, stop = false): Promise<MoveStatus> =>
    runMoveBetween(source, target, name, stop);

  const runMoveBack = (name: string): Promise<MoveStatus> =>
    runMoveBetween(target, source, name, false);

  return {
    source,
    target,
    sourceApp,
    targetApp,
    commits,
    runMove,
    runMoveBack,
    waitForMove,
  };
}

export async function createUbuntuImage(
  host: Readonly<Pick<TestImpd, 'createTestImage' | 'dataDir'>>,
): Promise<void> {
  await host.createTestImage('ubuntu');

  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');
}

export async function createZfsUbuntuImage(
  host: Readonly<Pick<TestImpd, 'db' | 'dataDir' | 'storage'>>,
): Promise<void> {
  await host.storage.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  await host.storage.createImage('sha256:ubuntu', () => Promise.resolve());

  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').rootfs, 'rootfs');
  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');

  await createImage(host.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });
}
