import type { Imp } from '@impz/api';
import { listImages, readImageById } from '../../platform/db/images';
import type { ImpRecord } from '../../platform/db/imps';
import { listLeases } from '../../platform/db/leases';
import type { LeaseRecord } from '../../platform/db/leases';
import type { ImpHttpsConfig } from '../imps-config';
import { readBootStatus } from './boot-status';
import type { ImpContext } from './imp-context';
import { MIB } from './imp-disk';
import { countSessions } from './sessions/count-sessions';

export interface ImpUrls {
  readonly local: string;

  readonly https: string | null;

  readonly public: string | null;

  readonly service: string | null;
  readonly tailnet: string | null;
}

const presentedLeases = new WeakMap<Imp, readonly LeaseRecord[]>();

export function readPresentedLeases(imp: Imp): readonly LeaseRecord[] | undefined {
  return presentedLeases.get(imp);
}

export interface ImpPresenter {
  readonly readApi: (imp: ImpRecord) => Promise<Imp>;
  readonly readApiList: (imps: readonly ImpRecord[]) => Promise<Imp[]>;
  readonly readUrls: (imp: ImpRecord) => Promise<ImpUrls>;
}

export function createImpPresenter(
  context: ImpContext,
  readSilentSince: (id: string) => Date | null,
): ImpPresenter {
  const buildLocalUrl = (name: string): string =>
    `http://${name}.imp.localhost:${String(context.config.proxyPort)}`;

  const readApiImp = (imp: ImpRecord, imageName: string, leases: readonly LeaseRecord[]): Imp => {
    const api: Imp = {
      id: imp.id,
      name: imp.name,
      image: imageName,
      state: imp.state,
      kind: imp.kind,
      vcpus: imp.vcpus,
      memoryMib: imp.memoryMib,
      diskMib: Math.ceil(imp.diskBytes / MIB),
      ip: imp.ip,
      slot: imp.slot,
      port: context.findAddress(imp.slot).tailnetPort,
      httpPort: imp.httpPort,
      url: buildLocalUrl(imp.name),
      createdAt: imp.createdAt,
      lastActiveAt: imp.lastActiveAt,
    };

    if (imp.maxMemoryMib > imp.memoryMib) {
      api.maxMemoryMib = imp.maxMemoryMib;
    }

    if (imp.sleptAt !== null) {
      api.sleptAt = imp.sleptAt;
    }

    if (!imp.isBackedUp) {
      api.backup = false;
    }

    if (imp.publicAuth !== null) {
      api.public = { auth: imp.publicAuth };
    }

    if (imp.holdUntil !== null && imp.holdUntil.getTime() > context.now()) {
      api.holdUntil = imp.holdUntil;
    }

    api.leases = { leases: [], otherCount: leases.length };

    if (imp.error !== null) {
      api.error = imp.error;
    }

    if (imp.moveState !== null) {
      api.move = imp.moveState;
    }

    const diskUsage = context.readDiskUsage(imp.id);

    if (diskUsage !== undefined) {
      api.diskUsage = diskUsage;
    }

    const paths = context.findPaths(imp.id);

    api.cpu = imp.cpu;

    const awakeMs =
      imp.awakeMs +
      (imp.awakeSince === null ? 0 : Math.max(0, context.now() - imp.awakeSince.getTime()));

    api.resources = { wakeCount: imp.wakeCount, awakeMs };

    if (imp.state === 'running' && imp.pid !== null) {
      const sample = context.resources.readSample({
        impId: imp.id,
        pid: imp.pid,
        apiSocket: paths.apiSocket,
        tap: context.findAddress(imp.slot).tap,
      });

      if (sample.ramMib !== null) {
        api.ramMib = sample.ramMib;
      }

      const pluggedMib = context.pluggedSizes.read(imp.id);

      if (pluggedMib !== undefined) {
        api.pluggedMib = pluggedMib;
      }

      if (sample.rssMib !== null) {
        api.rssMib = sample.rssMib;
      }

      api.resources.sample = {
        measuredAt: sample.measuredAt,
        since: sample.since,
        ...(sample.cpuPercent !== undefined && { cpuPercent: sample.cpuPercent }),
        cpuThrottledMs: sample.cpuThrottledMs,
        netRxBytes: sample.netRxBytes,
        netTxBytes: sample.netTxBytes,
      };
    }

    const sessions = countSessions(context, imp);

    if (sessions !== undefined) {
      api.sessions = sessions;
    }

    const silentSince = imp.state === 'running' ? readSilentSince(imp.id) : null;

    if (silentSince !== null) {
      api.agentSilentSince = silentSince;
    }

    const inner = imp.state === 'running' ? context.inners.read(imp.id) : undefined;

    if (inner !== undefined) {
      api.inner = {
        up: inner.up,
        restarts: inner.restarts,
        ...(inner.lastError !== undefined && { lastError: inner.lastError }),
      };
    }

    const shown = { ...api, ...readBootStatus(imp, paths, context.identity) };

    presentedLeases.set(shown, leases);

    return shown;
  };

  return {
    readApi: async (imp) => {
      const [image, leases] = await Promise.all([
        readImageById(context.db, imp.imageId),
        listLeases(context.db, context.now(), [imp.id]),
      ]);

      return readApiImp(imp, image?.name ?? 'unknown', leases);
    },
    readApiList: async (imps) => {
      const [images, leases] = await Promise.all([
        listImages(context.db),
        listLeases(
          context.db,
          context.now(),
          imps.map((imp) => imp.id),
        ),
      ]);

      const names = new Map(images.map((image) => [image.id, image.name]));

      const byImp = Map.groupBy(leases, (lease) => lease.impId);

      return imps.map((imp) =>
        readApiImp(imp, names.get(imp.imageId) ?? 'unknown', byImp.get(imp.id) ?? []),
      );
    },
    readUrls: async (imp) => {
      const local = buildLocalUrl(imp.name);
      const https = buildHttpsUrl(imp.name, context.config.https);
      const service = context.readServiceUrl(imp.name);
      const publicUrl = buildPublicUrl(imp, context.config.https);

      if (!context.config.tailscaleEnabled) {
        return { local, https, public: publicUrl, service, tailnet: null };
      }

      const live =
        context.readTailnetHostname === undefined ? null : await context.readTailnetHostname();

      const host = live ?? context.config.tailscaleHostname;
      const port = context.findAddress(imp.slot).tailnetPort;

      return {
        local,
        https,
        public: publicUrl,
        service,
        tailnet: `http://${host}:${String(port)}`,
      };
    },
  };
}

function buildHttpsUrl(name: string, https: ImpHttpsConfig | null): string | null {
  if (https === null) {
    return null;
  }

  const port = https.httpsPort === 443 ? '' : `:${String(https.httpsPort)}`;

  return `https://${name}.${https.domain}${port}`;
}

// Docker publishes the public listener as 443, so the URL has no port.
function buildPublicUrl(imp: ImpRecord, https: ImpHttpsConfig | null): string | null {
  if (imp.publicAuth === null || https === null || https.public === null) {
    return null;
  }

  return `https://${imp.name}.${https.domain}`;
}
