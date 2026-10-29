import type { EgressPolicy, ImpKind } from '@impz/api';
import { countSlots } from '../../host-net/net/addressing';
import type { ImageRecord } from '../../platform/db/images';
import { ImpClashError } from '../../platform/db/imp-clash-error';
import { createImpInFreeSlot, readImpByName } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { buildConflictError } from '../../platform/errors/impd-errors';
import { resolveCpuSettings } from './cpu-limit';
import type { ImpClock, ImpHost, ImpVms } from './imp-context';

const CREATE_TRIES = 3;

interface NewImpInput {
  readonly name?: string | undefined;
  readonly vcpus?: number | undefined;
  readonly memoryMib?: number | undefined;
  readonly maxMemoryMib?: number | undefined;
  readonly httpPort?: number | undefined;
  readonly diskBytes?: number | undefined;
  readonly policy?: EgressPolicy | undefined;
  readonly cpuLimit?: number | null | undefined;
  readonly cpuWeight?: number | undefined;
  readonly isIdentityResetPending?: boolean;
  readonly isBackedUp?: boolean | undefined;
  readonly networkIds?: readonly string[] | undefined;
  readonly moveState?: 'receiving' | undefined;
  readonly kind?: ImpKind | undefined;

  readonly slot?: number | undefined;
}

export async function createImpRecord(
  context: ImpHost & ImpClock & ImpVms,
  id: string,
  input: NewImpInput,
  image: ImageRecord,
): Promise<ImpRecord> {
  const cpu = resolveCpuSettings(input, null, context.hostCpus);

  const name = await resolveImpName(context, input.name);

  const createRecord = () =>
    createImpInFreeSlot(
      context.db,
      {
        id,
        name,
        imageId: image.id,
        imageDigest: image.digest,
        vcpus: input.vcpus ?? context.config.defaultVcpus,
        memoryMib: input.memoryMib ?? context.config.defaultMemoryMib,
        ...(input.maxMemoryMib !== undefined && { maxMemoryMib: input.maxMemoryMib }),
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
        ...(input.policy !== undefined && { egress: input.policy }),
        ...(input.networkIds !== undefined && { networkIds: input.networkIds }),
        ...(input.diskBytes !== undefined && { diskBytes: input.diskBytes }),
        ...(input.moveState !== undefined && { moveState: input.moveState }),
        ...(input.kind !== undefined && { kind: input.kind }),
        cpu,
        ...(input.isIdentityResetPending === true && { isIdentityResetPending: true }),
        ...(input.isBackedUp === false && { isBackedUp: false }),
      },
      {
        count: countSlots(context.config.subnet),
        findIp: (slot) => context.findAddress(slot).guestIp,
        slot: input.slot,
        now: context.now,
      },
    );

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createRecord();
    } catch (error) {
      const clash = error instanceof ImpClashError ? error.column : null;

      if (clash === 'jail_uid' && attempt < CREATE_TRIES) {
        continue;
      }

      if (clash !== null && clash !== 'jail_uid') {
        throw buildConflictError('imp', name);
      }

      throw error;
    }
  }
}

const NAME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

async function resolveImpName(context: ImpHost, requested: string | undefined): Promise<string> {
  if (requested !== undefined) {
    return requested;
  }

  for (;;) {
    const picks = Array.from({ length: 4 }, () => Math.random() * NAME_ALPHABET.length);
    const suffix = picks.map((pick) => NAME_ALPHABET[Math.floor(pick)]).join('');
    const name = `imp-${suffix}`;

    const taken = await readImpByName(context.db, name);

    if (taken === undefined) {
      return name;
    }
  }
}
