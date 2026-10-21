import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MoveTicket, WarmHost, WarmMove } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';
import type { Imps } from '../../imps/imps/imp-service';
import type { Broker } from '../../network/broker/broker-service';
import type { EgressService } from '../../network/egress/egress-service';
import type { ApiAudit } from '../../platform/audit/api-audit';
import { readImageByDigest, updateImageUse } from '../../platform/db/images';
import { listImps, readImpByName, updateImpCommitted } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { listLeases } from '../../platform/db/leases';
import {
  claimMoveTicketStream,
  createMoveTicketInFreeSlot,
  listMoveTickets,
  readMoveTicket,
  readStagedMoveTicket,
  removeMoveTickets,
  updateMoveTicket,
  writeMoveTicket,
} from '../../platform/db/move-tickets';
import type { MoveTicketRow, NewMoveTicketRow } from '../../platform/db/move-tickets';
import type { ImpDatabase } from '../../platform/db/open-database';
import { SlotTakenError } from '../../platform/db/slot-taken-error';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { hashSecret } from '../../platform/secrets/hash-secret';
import { mintOpaqueToken } from '../../platform/secrets/mint-opaque-token';
import type { OpaqueToken } from '../../platform/secrets/parse-opaque-token';
import { readSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import type { HostIdentity } from '../../vm/sleep/vm-identity';
import { buildSystemDrivePath } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import { COMMIT_WINDOW_MS } from './commit-window-ms';
import { MOVE_FINISH_HEADER, MOVE_PART_HEADER, MOVE_PATHS, MoveOfferSchema } from './move-header';
import { PART_WAIT_MS, createPartPipe } from './move-parts';
import type { PartPipe } from './move-parts';
import { MoveRequestError } from './move-request-error';
import { MOVE_TICKET_PREFIX, isSameHash, readTicketHeader } from './move-tickets';
import type { PeerRanges } from './peer-address';
import { readMoveStream } from './read-move-stream';
import type { Reply } from './read-move-stream';
import { removeStagedImp } from './remove-staged-imp';
import { collectWarmMismatches } from './warm-facts';

const STREAM_WINDOW_MS = 10 * 60 * 1000;

export interface MoveReceiver {
  readonly issueTicket: (name: string, bytes: number, warm?: WarmMove) => Promise<MoveTicket>;
  readonly reissueTicket: (name: string) => Promise<MoveTicket>;
  readonly respond: (request: Request, peer: string | null) => Promise<Response>;
  readonly recover: () => Promise<void>;
}

export interface MoveReceiverDeps {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<
    StorageBackend,
    | 'kind'
    | 'resolveImpPaths'
    | 'createImpDisk'
    | 'createCheckpoint'
    | 'createImage'
    | 'receiveMoveSnapshots'
  >;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly diskBudget: Pick<DiskBudget, 'requireRoom' | 'withRoom'>;
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp' | 'lockImpId'>;
  readonly grants: Pick<Broker, 'addGrant' | 'listSecrets'>;
  readonly egress: Pick<EgressService, 'writeAnswers'>;
  readonly ranges: PeerRanges;
  readonly readIdentity: () => HostIdentity;
  readonly readWarmHost: () => WarmHost;
  readonly readPeerUrl: () => Promise<string>;
  readonly onCommitted: (name: string) => void;
  readonly audit: Pick<ApiAudit, 'record'>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

interface CheckedTicket {
  readonly row: MoveTicketRow;
  readonly ticket: OpaqueToken;
}

interface ReceiveSession {
  readonly pipe: PartPipe;
  nextPart: number;
  lastPartAt: number;
  readonly result: Promise<Reply>;
}

export function createMoveReceiver(deps: MoveReceiverDeps): MoveReceiver {
  const tempDir = join(deps.dataDir, 'moves');

  const sessions = new Map<string, ReceiveSession>();

  const requireTicket = async (request: Request): Promise<CheckedTicket> => {
    const ticket = readTicketHeader(request);

    if (ticket === null) {
      throw new MoveRequestError(401, 'no move ticket in the Authorization header');
    }

    const row = await readMoveTicket(deps.db, ticket.id);

    if (
      row === undefined ||
      !isSameHash(row.secret_sha256, hashSecret(ticket.secret).toString('hex'))
    ) {
      throw new MoveRequestError(401, 'unknown move ticket');
    }

    return { row, ticket };
  };

  const writeTicketRow = async (
    name: string,
    bytes: number,
    fields: Partial<MoveTicketRow>,
    write: (row: NewMoveTicketRow) => Promise<void> = (row) => writeMoveTicket(deps.db, row),
  ) => {
    const created = mintOpaqueToken(MOVE_TICKET_PREFIX);
    const now = deps.now();

    await write({
      id: created.id,
      secret_sha256: hashSecret(created.secret).toString('hex'),
      name,
      bytes,
      imp_id: fields.imp_id ?? null,
      issued_at: now,
      stream_by: now + STREAM_WINDOW_MS,
      stream_used_at: fields.stream_used_at ?? null,
      receipt: fields.receipt ?? null,
      commit_until: fields.commit_until ?? null,
      committed_at: null,
      slot: fields.slot ?? null,
    });

    return {
      ticket: created.text,
      expiresAt: new Date(now + STREAM_WINDOW_MS),
      peerUrl: await deps.readPeerUrl(),
    };
  };

  const handleOffer = async (request: Request): Promise<Response> => {
    await requireTicket(request);

    const body: unknown = await request.json();

    const offer = MoveOfferSchema.parse(body);

    // The use goes in before the read, so an image eviction keeps the image this offer says the
    // target holds until the stream reuses it.
    await updateImageUse(deps.db, 'digest', [offer.imageDigest], deps.now());

    const existing = await readImageByDigest(deps.db, offer.imageDigest);

    const needsSystemDrive =
      offer.systemDrive !== undefined &&
      !existsSync(buildSystemDrivePath(deps.dataDir, offer.systemDrive));

    return Response.json({
      needsImage: existing === undefined,
      needsSystemDrive,
      storage: deps.storage.kind,
      keepsMaxMemory: true,
      keepsLeases: true,
      keepsPublicEgress: true,
      keepsBackupOff: true,
    });
  };

  const readStreamOrFail = async (
    pipe: PartPipe,
    row: MoveTicketRow,
    secret: string,
  ): Promise<Reply> => {
    try {
      return await readMoveStream(deps, tempDir, pipe.stream, row, secret);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));

      pipe.fail(failure);

      await updateMoveTicket(deps.db, row.id, { slot: null });

      return readErrorReply(error, deps.log);
    }
  };

  const openSession = async (row: MoveTicketRow, secret: string): Promise<ReceiveSession> => {
    if (deps.now() > row.stream_by) {
      throw new MoveRequestError(410, 'the move ticket expired before its stream started');
    }

    const isClaimed = await claimMoveTicketStream(deps.db, row.id, deps.now());

    if (!isClaimed) {
      throw new MoveRequestError(409, 'the move ticket was used for a stream already');
    }

    const pipe = createPartPipe();
    const result = readStreamOrFail(pipe, row, secret);
    const session: ReceiveSession = { pipe, nextPart: 0, lastPartAt: deps.now(), result };

    sessions.set(row.id, session);
    void removeSessionLater(row.id, result);

    return session;
  };

  const removeSessionLater = async (id: string, result: Promise<Reply>): Promise<void> => {
    await result;

    setTimeout(() => {
      sessions.delete(id);
    }, PART_WAIT_MS).unref();
  };

  const handleReceive = async (request: Request): Promise<Response> => {
    const checked = await requireTicket(request);

    const row = checked.row;
    const part = Number(request.headers.get(MOVE_PART_HEADER) ?? '0');
    const existing = sessions.get(row.id);

    if (request.headers.get(MOVE_FINISH_HEADER) === '1') {
      if (existing === undefined) {
        throw new MoveRequestError(409, 'no stream to finish for this ticket');
      }

      existing.pipe.end();

      const reply = await existing.result;

      sessions.delete(row.id);

      return Response.json(reply.body, { status: reply.status });
    }

    const session = part === 0 ? await openSession(row, checked.ticket.secret) : existing;

    if (session?.nextPart !== part || request.body === null) {
      throw new MoveRequestError(409, `part ${String(part)} is out of order`);
    }

    if (part > 0 && deps.now() - session.lastPartAt > PART_WAIT_MS) {
      session.pipe.fail(
        new MoveRequestError(410, 'the next part of the move stream came too late'),
      );

      const reply = await session.result;

      return Response.json(reply.body, { status: reply.status });
    }

    session.nextPart += 1;
    session.lastPartAt = deps.now();

    try {
      await session.pipe.push(request.body);

      session.lastPartAt = deps.now();
    } catch {
      const reply = await session.result;

      return Response.json(reply.body, { status: reply.status });
    }

    return Response.json({ part }, { status: 202 });
  };

  const writeCommit = async (imp: ImpRecord, row: MoveTicketRow): Promise<void> => {
    const isWarm = row.slot !== null;

    if (isWarm && readSnapshotMeta(deps.storage.resolveImpPaths(imp.id)) === null) {
      throw new MoveRequestError(409, 'the received memory snapshot is not complete');
    }

    const committed = await updateImpCommitted(deps.db, imp.id, deps.now(), isWarm);

    deps.onCommitted(row.name);

    const leases = await listLeases(deps.db, deps.now(), [imp.id]);

    if (leases.length > 0) {
      deps.db.writes.publish({ kind: 'changed', imp: committed, reason: 'held' });
    }

    deps.log(`impd: move: ${row.name}: committed; it lives here now`);
  };

  const handleCommit = async (request: Request): Promise<Response> => {
    const checked = await requireTicket(request);

    const impId = checked.row.imp_id;

    if (checked.row.receipt === null || impId === null) {
      throw new MoveRequestError(409, 'nothing to commit: no receipt for this ticket');
    }

    return deps.imps.lockImpId(impId, async (imp) => {
      const row = await readMoveTicket(deps.db, checked.row.id);

      const settled = row === undefined ? 'none' : readSettled(row, imp);

      if (settled === 'committed') {
        return Response.json({ isCommitted: true });
      }

      if (row === undefined || imp === undefined || settled === 'none') {
        throw new MoveRequestError(409, 'nothing to commit: the received copy is gone');
      }

      if (row.commit_until !== null && deps.now() > row.commit_until) {
        throw new MoveRequestError(410, 'the commit window ended; reissue the ticket');
      }

      await writeCommit(imp, row);

      return Response.json({ isCommitted: true });
    });
  };

  const handleAbort = async (request: Request): Promise<Response> => {
    const checked = await requireTicket(request);

    const impId = checked.row.imp_id;

    sessions.get(checked.row.id)?.pipe.fail(new Error('the source aborted the move'));
    const removeTickets = () => removeMoveTickets(deps.db, checked.row.id, impId);

    if (impId === null) {
      await removeTickets();

      return Response.json({ isCommitted: false });
    }

    const settled = await deps.imps.lockImpId(impId, async (imp) => {
      const row = await readMoveTicket(deps.db, checked.row.id);

      const found = row === undefined ? 'none' : readSettled(row, imp);

      if (found !== 'committed') {
        await removeTickets();
      }

      return found;
    });

    if (settled === 'committed') {
      return Response.json({ isCommitted: true }, { status: 409 });
    }

    await removeStagedImp(deps, checked.row.name, impId);

    deps.log(`impd: move: ${checked.row.name}: aborted by the source`);

    return Response.json({ isCommitted: false });
  };

  const handleRoute = async (request: Request, peer: string | null): Promise<Response> => {
    const route = ROUTES[new URL(request.url).pathname];

    if (route === undefined || request.method !== 'POST') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    if (peer === null || !deps.ranges.isAllowed(peer)) {
      return Response.json({ error: 'moves come only over the tailnet' }, { status: 403 });
    }

    try {
      return await route(request);
    } catch (error) {
      const reply = readErrorReply(error, deps.log);

      return Response.json(reply.body, { status: reply.status });
    }
  };

  const ROUTES: Readonly<Record<string, (request: Request) => Promise<Response>>> = {
    [MOVE_PATHS.offer]: handleOffer,
    [MOVE_PATHS.receive]: handleReceive,
    [MOVE_PATHS.commit]: handleCommit,
    [MOVE_PATHS.abort]: handleAbort,
  };

  return {
    issueTicket: async (name, bytes, warm) => {
      const taken = await readImpByName(deps.db, name);

      if (taken !== undefined) {
        throw new ORPCError('CONFLICT', {
          message: `this host has an imp named ${name}`,
          data: { kind: 'imp' as const, name },
        });
      }

      await deps.diskBudget.requireRoom(2 * bytes);

      if (warm === undefined) {
        return writeTicketRow(name, bytes, {});
      }

      const mismatches = collectWarmMismatches(warm, deps.readWarmHost());

      if (mismatches.length > 0) {
        throw new ORPCError('PRECONDITION_FAILED', {
          message: `this host cannot load ${name}'s memory: ${mismatches.join('; ')}`,
        });
      }

      return writeTicketRow(name, bytes, { slot: warm.slot }, async (row) => {
        const isKept = await createMoveTicketInFreeSlot(
          deps.db,
          { ...row, slot: warm.slot },
          deps.now(),
        );

        if (!isKept) {
          throw new ORPCError('CONFLICT', {
            message: `slot ${String(warm.slot)}, which ${name}'s memory needs, is taken here`,
          });
        }
      });
    },

    reissueTicket: async (name) => {
      const imp = await readImpByName(deps.db, name);

      const staged =
        imp?.moveState === 'receiving' ? await readStagedMoveTicket(deps.db, imp.id) : undefined;

      if (imp === undefined || staged === undefined) {
        throw new ORPCError('NOT_FOUND', {
          message: `no imp named ${name} waits for a commit here`,
          data: { kind: 'imp' as const, name },
        });
      }

      return writeTicketRow(name, 0, {
        imp_id: imp.id,
        stream_used_at: deps.now(),
        receipt: staged.receipt,
        commit_until: deps.now() + COMMIT_WINDOW_MS,
        slot: staged.slot,
      });
    },

    respond: async (request, peer) => {
      const startedAt = deps.now();

      const path = new URL(request.url).pathname;

      const ticket = readTicketHeader(request);
      const row = ticket === null ? undefined : await readMoveTicket(deps.db, ticket.id);

      const response = await handleRoute(request, peer);

      const failure = response.ok ? null : new ORPCError(readStatusCode(response.status));

      deps.audit.record(
        {
          procedure: `move.${path.slice(path.lastIndexOf('/') + 1)}`,
          actor: { kind: 'tailnet', name: `move from ${peer ?? 'unknown'}` },
          impName: row?.name ?? null,
          startedAt,
        },
        failure,
      );

      return response;
    },

    recover: async () => {
      const rows = await listMoveTickets(deps.db);

      for (const row of rows) {
        const isCutShort = row.stream_used_at !== null && row.receipt === null;
        const isUnused = row.stream_used_at === null && deps.now() > row.stream_by;

        const isSpent =
          row.committed_at !== null && row.commit_until !== null && deps.now() > row.commit_until;

        if (isCutShort && row.imp_id !== null) {
          await removeStagedImp(deps, row.name, row.imp_id);
        }

        if (isCutShort || isUnused || isSpent) {
          await removeMoveTickets(deps.db, row.id, null);
        }
      }

      const left = await listMoveTickets(deps.db);

      const ticketed = new Set(left.map((row) => row.imp_id));

      for (const imp of await listImps(deps.db)) {
        if (imp.moveState === 'receiving' && !ticketed.has(imp.id)) {
          await removeStagedImp(deps, imp.name, imp.id);
        }
      }

      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function readErrorReply(error: unknown, log: (message: string) => void): Reply {
  const status = readErrorStatus(error);

  if (status === 500) {
    log(`impd: move: ${getErrorMessage(error)}`);
  }

  return { status, body: { error: getErrorMessage(error) } };
}

function readErrorStatus(error: unknown): number {
  if (error instanceof MoveRequestError) {
    return error.status;
  }

  return error instanceof SlotTakenError ? 409 : 500;
}

function readSettled(
  row: MoveTicketRow,
  imp: ImpRecord | undefined,
): 'committed' | 'staged' | 'none' {
  if (row.committed_at !== null || (imp !== undefined && imp.moveState === null)) {
    return 'committed';
  }

  return imp?.moveState === 'receiving' ? 'staged' : 'none';
}

const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
};

function readStatusCode(status: number): string {
  return STATUS_CODES[status] ?? 'INTERNAL_SERVER_ERROR';
}
