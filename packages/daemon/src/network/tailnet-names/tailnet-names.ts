import { listImps } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { createSemaphore } from '../../platform/process/semaphore';
import { listServeEntries } from './service-serve';
import type { ServedServices, ServiceServe } from './service-serve';
import type { ServiceDefinition, ServicesApi, TailnetService } from './services-api';
import type { TailnetNamesConfig } from './tailnet-names-config';

// the tailnet policy must let tag:imp hosts serve this tag and members reach it
export const SERVICE_TAG = 'tag:imp-svc';
const SERVICE_PORTS = ['tcp:80', 'tcp:443'];

interface TailnetNameFailure {
  readonly name: string;
  readonly error: string;
}

export interface TailnetNamesStatus {
  readonly live: number;
  readonly failed: readonly TailnetNameFailure[];
}

export interface TailnetNames {
  readonly runSync: () => Promise<void>;

  readonly readUrl: (impName: string) => string | null;
  readonly readStatus: () => TailnetNamesStatus;
}

export interface TailnetNamesDeps {
  readonly config: TailnetNamesConfig;
  readonly hostId: string;
  readonly db: ImpDatabase;
  readonly api: ServicesApi;
  readonly serve: ServiceServe;

  readonly findPort: (slot: number) => number;

  readonly isImpPresent: (name: string) => Promise<boolean>;

  readonly readSuffix: () => Promise<string | null>;
  readonly log: (message: string) => void;
}

type NameState = { readonly live: true } | { readonly live: false; readonly error: string };

export function createTailnetNames(deps: TailnetNamesDeps): TailnetNames {
  const owner = `imp host ${deps.hostId}`;

  const states = new Map<string, NameState>();

  const pass = createSemaphore(1);
  const view: { suffix: string | null } = { suffix: null };
  const toService = (impName: string): string => `svc:${deps.config.prefix}${impName}`;

  const isOurs = (service: TailnetService): boolean =>
    (service.tags ?? []).includes(SERVICE_TAG) && service.comment === owner;

  const writeState = (impName: string, next: NameState): void => {
    const last = states.get(impName);

    if (!next.live && (last === undefined || last.live || last.error !== next.error)) {
      deps.log(`impd: tailnet names: ${impName}: ${next.error}`);
    }

    if (next.live && last?.live !== true) {
      deps.log(`impd: tailnet names: ${impName} is ${toService(impName)}`);
    }

    states.set(impName, next);
  };

  const claimService = async (service: string, listed: TailnetService | undefined) => {
    if (listed !== undefined && !isOurs(listed)) {
      throw new Error(`${service} exists and this host does not own it`);
    }

    const definition: ServiceDefinition = {
      name: service,
      comment: owner,
      ports: SERVICE_PORTS,
      tags: [SERVICE_TAG],
    };

    if (listed !== undefined && isSameDefinition(listed, definition)) {
      return;
    }

    // The API has no conditional write, so a service someone makes between
    // this read and the PUT is overwritten; the read narrows that to the
    // time one request takes.
    const current = await deps.api.readService(service);

    if (current !== null && !isOurs(current)) {
      throw new Error(`${service} exists and this host does not own it`);
    }

    await deps.api.writeService(definition);
  };

  const removeService = async (service: string, isServed: boolean) => {
    const impName = service.slice(`svc:${deps.config.prefix}`.length);

    const present = await deps.isImpPresent(impName);

    if (present) {
      return;
    }

    if (isServed) {
      await deps.serve.clearServe(service);
    }

    await deps.api.removeService(service);

    deps.log(`impd: tailnet names: removed ${service}, which no imp has`);
  };

  const runPass = async (): Promise<void> => {
    view.suffix = await deps.readSuffix();

    const listed = await listImps(deps.db);

    const imps = listed.filter((imp) => imp.moveState === null && imp.kind === 'user');

    const wanted = new Map(imps.map((imp) => [toService(imp.name), imp]));

    for (const name of states.keys()) {
      if (!wanted.has(toService(name))) {
        states.delete(name);
      }
    }

    let services: readonly TailnetService[];
    let served: ServedServices;

    try {
      services = await deps.api.listServices();
      served = await deps.serve.readServed();
    } catch (error) {
      for (const imp of imps) {
        writeState(imp.name, { live: false, error: getErrorMessage(error) });
      }

      return;
    }

    const byName = new Map(services.map((service) => [service.name, service]));

    for (const [service, imp] of wanted) {
      try {
        await claimService(service, byName.get(service));

        const target = `http://127.0.0.1:${String(deps.findPort(imp.slot))}`;

        if (!isSameEntries(served.get(service) ?? [], listServeEntries(target))) {
          await deps.serve.writeServe(service, target);
        }

        writeState(imp.name, { live: true });
      } catch (error) {
        writeState(imp.name, { live: false, error: getErrorMessage(error) });
      }
    }

    for (const service of services) {
      if (isOurs(service) && !wanted.has(service.name)) {
        await tryRemove(service.name, () => removeService(service.name, served.has(service.name)));
      }
    }

    for (const service of served.keys()) {
      if (!wanted.has(service) && !byName.has(service)) {
        await tryRemove(service, () => deps.serve.clearServe(service));
      }
    }
  };

  const tryRemove = async (service: string, remove: () => Promise<void>): Promise<void> => {
    try {
      await remove();
    } catch (error) {
      deps.log(`impd: tailnet names: removing ${service}: ${getErrorMessage(error)}`);
    }
  };

  return {
    runSync: () => pass.run(runPass),
    readUrl: (impName) =>
      states.get(impName)?.live === true && view.suffix !== null
        ? `https://${deps.config.prefix}${impName}.${view.suffix}`
        : null,
    readStatus: () => {
      const failed: TailnetNameFailure[] = [];
      let live = 0;

      for (const [name, state] of states) {
        if (state.live) {
          live += 1;
        } else {
          failed.push({ name, error: state.error });
        }
      }

      return { live, failed };
    },
  };
}

function isSameDefinition(service: TailnetService, definition: ServiceDefinition): boolean {
  return isSameEntries(service.ports ?? [], definition.ports);
}

function isSameEntries(have: readonly string[], want: readonly string[]): boolean {
  return have.length === want.length && want.every((entry) => have.includes(entry));
}
