import { existsSync, rmSync } from 'node:fs';
import { toJson } from '@bufbuild/protobuf';
import type { JsonValue } from '@bufbuild/protobuf';
import * as z from 'zod';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-369 moves this to the layer that owns it
import type { SeenSession } from '../../imps/sessions/session-cache';
import { writeFileDurably, writeRenamed } from '../../platform/process/write-file-durably';
import { ServicesListSchema, SessionInfoSchema } from '../agent-client/agent-protocol';
import type { ServicesList } from '../agent-client/agent-protocol';
import { decodeAgentMessage } from '../agent-client/decode-agent-message';
import { hasAgentNameForms } from '../agent-client/has-agent-name-forms';
import type { ImpPaths } from '../storage/data-layout';
import { readRegularFile } from '../vmm/vm-files';
import { findCpuChange } from './cpu-identity';
import type { HostIdentity, VmIdentity } from './vm-identity';

// A Firecracker memory snapshot holds the guest kernel and the page cache of the system drive it
// reopens by path, so it is tied to the identity of the VM that wrote it.
const SnapshotIdentitySchema = z.object({
  firecrackerVersion: z.string(),
  snapshotVersion: z.string(),
  hostKernel: z.string(),
  guestKernel: z.string(),
  systemDrive: z.string(),
  systemDrivePath: z.string().optional(),
  agentVersion: z.string().optional(),
  ipv6Prefix: z.string().nullable().optional(),
  cpuModel: z.string().optional(),
  cpuFlags: z.string().optional(),
});

const AGENT_RECORD_JSON = { useProtoFieldName: true, alwaysEmitImplicit: true } as const;

const SeenSessionJsonSchema = z.json().transform((json, ctx): SeenSession => {
  try {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new Error('a session is a JSON object');
    }

    const { observed_unix_ms: observed, ...rest } = json;
    const session = decodeAgentMessage(SessionInfoSchema, rest);

    if (!hasAgentNameForms(session)) {
      throw new Error('a session whose names lack their agent’s form');
    }

    return typeof observed === 'number' ? { ...session, observedUnixMs: observed } : session;
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: String(error) });

    return z.NEVER;
  }
});

const ServicesListJsonSchema = z.json().transform((json, ctx): ServicesList => {
  try {
    return decodeAgentMessage(ServicesListSchema, json);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: String(error) });

    return z.NEVER;
  }
});

export const SnapshotMetaSchema = SnapshotIdentitySchema.extend({
  createdAt: z.int(),
  memoryMib: z.int(),
  ramMib: z.int().nonnegative(),
  pluggedMib: z.int().nonnegative().optional(),
  sessions: z.array(SeenSessionJsonSchema).readonly().optional(),
  services: ServicesListJsonSchema.optional(),
});

export type SnapshotIdentity = z.infer<typeof SnapshotIdentitySchema>;

export type SnapshotMeta = z.output<typeof SnapshotMetaSchema>;

export function buildSnapshotIdentity(
  vm: Readonly<VmIdentity> | null,
  host: Readonly<HostIdentity>,
): SnapshotIdentity {
  if (vm === null) {
    return {
      firecrackerVersion: host.firecrackerVersion,
      snapshotVersion: host.snapshotVersion,
      hostKernel: host.hostKernel,
      guestKernel: 'unknown',
      systemDrive: 'unknown',
    };
  }

  return {
    firecrackerVersion: vm.firecrackerVersion,
    snapshotVersion: vm.snapshotVersion,
    hostKernel: vm.hostKernel,
    guestKernel: vm.guestKernel,
    systemDrive: vm.systemDrive,
    systemDrivePath: vm.systemDrivePath,
    agentVersion: vm.agentVersion,
    ...(vm.ipv6Prefix !== undefined && { ipv6Prefix: vm.ipv6Prefix }),
    ...(vm.cpuModel !== undefined && { cpuModel: vm.cpuModel }),
    ...(vm.cpuFlags !== undefined && { cpuFlags: vm.cpuFlags }),
  };
}

// The record is the snapshot's commit marker: a caller writes it last, after the files it vouches
// for are complete.
export function writeSnapshotMeta(
  paths: Pick<ImpPaths, 'snapshotMeta'>,
  meta: Readonly<SnapshotMeta>,
): void {
  writeFileDurably(paths.snapshotMeta, `${JSON.stringify(encodeSnapshotMeta(meta), null, 2)}\n`);
}

export type SnapshotMetaJson = Omit<SnapshotMeta, 'sessions' | 'services'> & {
  readonly sessions?: readonly JsonValue[];
  readonly services?: JsonValue;
};

export function encodeSnapshotMeta(meta: Readonly<SnapshotMeta>): SnapshotMetaJson {
  const { sessions, services, ...identity } = meta;

  return {
    ...identity,
    ...(sessions !== undefined && {
      sessions: sessions.map((session) => encodeSeenSession(session)),
    }),
    ...(services !== undefined && {
      services: toJson(ServicesListSchema, services, AGENT_RECORD_JSON),
    }),
  };
}

function encodeSeenSession(session: SeenSession): JsonValue {
  const json = toJson(SessionInfoSchema, session, AGENT_RECORD_JSON);

  if (
    session.observedUnixMs === undefined ||
    typeof json !== 'object' ||
    json === null ||
    Array.isArray(json)
  ) {
    return json;
  }

  return { ...json, observed_unix_ms: session.observedUnixMs };
}

export function removeSnapshotMeta(paths: Readonly<ImpPaths>): void {
  rmSync(paths.snapshotMeta, { force: true });
  rmSync(buildLoadingPath(paths), { force: true });
}

function buildLoadingPath(paths: Pick<ImpPaths, 'snapshotMeta'>): string {
  return `${paths.snapshotMeta}.loading`;
}

export function setSnapshotLoading(paths: Readonly<ImpPaths>): void {
  // Once a load starts, the guest may run and write its disk, so after a crash the snapshot no
  // longer loads.
  writeRenamed(paths.snapshotMeta, buildLoadingPath(paths));
}

export function resetSnapshotLoading(paths: Readonly<ImpPaths>): void {
  writeRenamed(buildLoadingPath(paths), paths.snapshotMeta);
}

export function readLoadingMeta(paths: Readonly<ImpPaths>): SnapshotMeta | null {
  const path = buildLoadingPath(paths);

  try {
    return SnapshotMetaSchema.parse(JSON.parse(readRegularFile(path)));
  } catch {
    return null;
  }
}

export function readSnapshotMeta(paths: Readonly<ImpPaths>): SnapshotMeta | null {
  if (!existsSync(paths.vmstate) || !existsSync(paths.memFile)) {
    return null;
  }

  try {
    return SnapshotMetaSchema.parse(JSON.parse(readRegularFile(paths.snapshotMeta)));
  } catch {
    return null;
  }
}

export function probeSnapshot(paths: Readonly<ImpPaths>): boolean {
  return readSnapshotMeta(paths) !== null;
}

export function readColdBootReason(
  meta: Readonly<SnapshotIdentity>,
  host: Readonly<HostIdentity>,
): string | null {
  // The guest kernel does not count, because the snapshot holds it in memory.
  const keys = ['firecrackerVersion', 'snapshotVersion', 'hostKernel'] as const;

  for (const key of keys) {
    if (meta[key] !== host[key]) {
      return `${key} changed (${meta[key]} → ${host[key]})`;
    }
  }

  if (meta.systemDrivePath === undefined) {
    return 'the snapshot is from an older impd';
  }

  const cpuChange = findCpuChange(meta, host);

  if (cpuChange !== null) {
    return cpuChange;
  }

  // A guest woken with an address in another prefix would keep sending from it.
  const hostPrefix = host.ipv6Prefix ?? null;

  if (typeof meta.ipv6Prefix === 'string' && meta.ipv6Prefix !== hostPrefix) {
    return `the IPv6 prefix changed (${meta.ipv6Prefix} → ${hostPrefix ?? 'off'})`;
  }

  if (!existsSync(meta.systemDrivePath)) {
    return `its agent drive ${meta.systemDrive.slice(0, 12)} is gone`;
  }

  return null;
}

export function removeSnapshot(paths: Readonly<ImpPaths>): void {
  rmSync(paths.snapshotDir, { recursive: true, force: true });
}
