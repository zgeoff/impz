import type { ExposeResult, PublicAuth } from '@impz/api';
import { readImpByName, updateImpExposure } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError } from '../../platform/errors/impd-error';
import { buildMovingError, buildNotFoundError } from '../../platform/errors/impd-errors';
import { mintSecret } from '../../platform/secrets/mint-secret';
import type { HttpsConfig } from './https-config';
import type { RecordsStatus } from './https-service';
import { buildCredentialHash } from './public-auth';

const DEFAULT_USER = 'imp';

interface ExposeRequest {
  readonly name: string;
  readonly auth: PublicAuth;
  readonly user?: string | undefined;
}

export interface ExposureService {
  readonly expose: (request: ExposeRequest) => Promise<ExposeResult>;
  readonly unexpose: (name: string) => Promise<ImpRecord>;
}

interface ExposureDeps {
  readonly db: ImpDatabase;
  readonly https: HttpsConfig | null;

  readonly updateRecords: () => Promise<RecordsStatus | null>;
}

export function createExposureService(deps: ExposureDeps): ExposureService {
  const requireImp = async (name: string): Promise<ImpRecord> => {
    const imp = await readImpByName(deps.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    if (imp.moveState !== null) {
      throw buildMovingError(name);
    }

    return imp;
  };

  return {
    expose: async (request) => {
      const https = deps.https;

      if (https === null || https.public === null) {
        throw new ImpdError('PRECONDITION_FAILED', {
          message: 'public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host',
        });
      }

      const imp = await requireImp(request.name);

      const credential = request.auth === 'none' ? null : mintSecret();
      const user = request.auth === 'basic' ? (request.user ?? DEFAULT_USER) : null;

      const changed = await updateImpExposure(deps.db, imp.id, {
        auth: request.auth,
        user,
        hash: credential === null ? null : buildCredentialHash(credential),
      });

      if (changed === undefined) {
        throw buildMovingError(imp.name);
      }

      const records = await deps.updateRecords();

      const isWritten = records === null || records.isOk;

      return {
        url: `https://${imp.name}.${https.domain}`,
        auth: request.auth,
        user,
        credential,
        ...(!isWritten && {
          warning: `the DNS record for ${imp.name}.${https.domain} is not written yet (${records.error ?? 'unknown error'}); impd tries again every 10 minutes`,
        }),
      };
    },
    unexpose: async (name) => {
      const imp = await requireImp(name);
      const changed = await updateImpExposure(deps.db, imp.id, null);

      if (changed === undefined) {
        throw buildMovingError(imp.name);
      }

      await deps.updateRecords();

      return changed;
    },
  };
}
