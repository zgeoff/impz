import { onTestFinished } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { MoveStatus } from '@impz/api';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { createImage } from '../../src/db/images';
import { listMoveTickets } from '../../src/db/move-tickets';
import { readWarmHost } from '../../src/moves/warm-facts';
import { deriveSlotAddress } from '../../src/net/addressing';
import type { StartTimer } from '../../src/process/clock';
import { buildImagePaths } from '../../src/storage/data-layout';
import { startTestImpd } from '../start-test-impd';
import type { TestImpd, TestImpdOptions } from '../start-test-impd';

// the target's peer URL: a literal tailnet address, as a move needs
export const TARGET_URL = 'http://100.100.0.2:7070';

// the source's address, as the target's socket sees it
export const SOURCE_PEER = '100.100.0.1';

// what a hook may reach when a request goes: the target's clock and the
// source's client
interface MoveHookHosts {
  readonly target: Readonly<Pick<TestImpd, 'advance'>>;
  readonly sourceApp: Readonly<Pick<TestImpd, 'client'>>;
}

// `forward` sends the request to the target's move routes, or the one it is
// given in its place
export type FetchHook = (
  request: Request,
  forward: (replacement?: Request) => Promise<Response>,
  hosts: Readonly<MoveHookHosts>,
) => Promise<Response>;

export interface MoveHostsOptions {
  // sees each request the source sends to the target's move routes
  readonly hook?: FetchHook;

  // the timer of the source's deadline on each request to the target
  readonly startPeerDeadline?: StartTimer;
  readonly partBytes?: number;

  // the source's taps' MACs; each slot's own by default
  readonly readTapMac?: (tap: string) => string | null;

  // Both hosts report the target's warm facts, and the source's VMs open
  // the target's system drive path. Two impds in one process cannot share
  // a data dir, as a warm move needs.
  readonly isShared?: boolean;
  readonly source?: TestImpdOptions;
  readonly target?: TestImpdOptions;

  // how long a move may take; a real pool takes seconds
  readonly moveTimeoutMs?: number;
}

// Two impds in one process: `source` sends to `target` through `fetch`, as
// from the tailnet. One stack releases both at the test's end, the target
// first; a throw in one release does not skip the other.
export function setupMoveHosts(options: MoveHostsOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return createMoveHosts(stack, options);
}

// setupMoveHosts' hosts, their releases in `stack`, for a test whose own
// resources must outlive both impds
export async function createMoveHosts(
  stack: Readonly<AsyncDisposableStack>,
  options: MoveHostsOptions = {},
) {
  const target = await startTestImpd(stack, {
    ...options.target,
    env: { IMP_PEER_URL: TARGET_URL, ...options.target?.env },
  });

  const facts = readWarmHost(target.config, target.readIdentity(), target.storage.kind);
  const shared = options.isShared === true ? { readWarmHost: () => facts } : {};
  const slotPlan = { subnet: target.config.subnet, portBase: 0 };
  const sendToTarget = (request: Request) => target.moves.handle(request, SOURCE_PEER);
  const hook = options.hook;

  // the source, once started, for the hook to see; no request goes before
  const built: { hosts: MoveHookHosts | null } = { hosts: null };

  const runHook = (request: Request, call: FetchHook): Promise<Response> => {
    invariant(built.hosts);

    return call(request, (replacement) => sendToTarget(replacement ?? request), built.hosts);
  };

  const source = await startTestImpd(stack, {
    ...options.source,
    boundaries: {
      ...options.source?.boundaries,
      moves: {
        ...shared,
        readTapMac:
          options.readTapMac ??
          ((tap) => deriveSlotAddress(Number(tap.slice('imp'.length)), slotPlan).hostMac),
        fetch: (request) => (hook === undefined ? sendToTarget(request) : runHook(request, hook)),
        ...(options.startPeerDeadline !== undefined && {
          startPeerDeadline: options.startPeerDeadline,
        }),
        ...(options.partBytes !== undefined && { partBytes: options.partBytes }),
      },
    },
  });

  // the source's VMs open the target's system drive path
  if (options.isShared === true) {
    await source.restartImpd({
      ...source.readIdentity(),
      systemDrivePath: target.readIdentity().systemDrivePath,
    });
  }

  const sourceApp = { client: source.client };
  const targetApp = { client: target.client };

  built.hosts = { target, sourceApp };

  const waitForMove = (name: string): Promise<MoveStatus> =>
    waitFor(
      async () => {
        const status = await source.client.moves.status({ name });

        if (!status.isDone && status.error === null) {
          throw new Error(`the move of ${name} never ended`);
        }

        return status;
      },
      { timeoutMs: options.moveTimeoutMs ?? 5000 },
    );

  // a whole move, as `impz move` runs it (packages/cli/src/commands/move-command.ts):
  // ZFS streams to a ZFS target, and the memory too when the facts match;
  // a stop forces, as --stop does
  const runMove = async (name: string, stop = false): Promise<MoveStatus> => {
    const info = await target.client.system.info();
    const targetFacts = await target.client.moves.facts();

    const plan = await source.client.moves.prepare({
      name,
      stop,
      ...(stop && { force: true }),
      targetStorage: info.storage.backend,
      target: targetFacts,
    });

    const ticket = await target.client.moves.receive({
      name,
      bytes: plan.bytes,
      ...(plan.warm !== null && { warm: plan.warm }),
    });

    await source.client.moves.send({ name, to: ticket.peerUrl, ticket: ticket.ticket });

    return waitForMove(name);
  };

  // the names of the moves the target committed, in order; a commit marks
  // every ticket of its imp, a reissued one too, so it counts once
  const readCommits = async (): Promise<string[]> => {
    const tickets = await listMoveTickets(target.db);

    const commits = new Map(
      tickets
        .filter((ticket) => ticket.committed_at !== null)
        .toSorted((first, second) => (first.committed_at ?? 0) - (second.committed_at ?? 0))
        .map((ticket) => [`${ticket.imp_id ?? ''} ${String(ticket.committed_at)}`, ticket.name]),
    );

    return [...commits.values()];
  };

  return {
    source,
    target,
    sourceApp,
    targetApp,
    readCommits,
    runMove,
    waitForMove,
  };
}

// the `ubuntu` test image, with the config.json a create reads
export async function createUbuntuImage(
  host: Readonly<Pick<TestImpd, 'createTestImage' | 'dataDir'>>,
): Promise<void> {
  await host.createTestImage('ubuntu');

  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');
}

// the `ubuntu` image on a host whose storage is buildStubZfsStorage's: the
// storage starts, then the image is a dataset with the files a create reads
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
