import type { SystemFeaturesInfo, SystemInfo } from '@impz/api';
import { ORPCError } from '@orpc/client';
import type { CallOptions } from './types';
import { UnknownProcedureError } from './unknown-procedure-error';

export type ImpdFeatures = SystemFeaturesInfo['features'];

export type ImpdFeature = keyof ImpdFeatures;

const FEATURE_GAPS = {
  sessionOffsets: 'has no session offsets',
  leases: 'has no leases',
  grantableTokens: 'is older than 0.27.0',
  secretRebind: 'is older than 0.27.0',
  tokenUpdate: 'is older than 0.34.0',
  tokenImageAdd: 'has no token image adds',
  databaseCopy: 'is older than 0.30.0',
  imageOpStream: 'has no image add or build streams',
  imageBuilds: 'has no list of running image builds',
  execRequire: 'is older than 0.30.0',
  oauthGrants: 'has no oauth grants',
  secretFilesGc: 'has no gc of secret files',
  sessionLog: 'has no session logs',
  publicEgress: 'is older than 0.35.0',
  oauthSecrets: 'has no oauth secrets',
  secretUpstream: 'has no secret upstreams',
  secretPresets: 'has no static secrets or presets',
  backupOptOut: 'has no backup opt-out',
  brokerRefusals: 'has no audit of refused broker requests',
  grantFilters: 'has no grant filters',
  readOnlyFiles: 'has no read-only files',
  execDropSysAdmin: 'cannot drop CAP_SYS_ADMIN from a command',
  guestScratch: 'does not name the guest scratch folder',
  imagePins: 'has no image pins',
  buildContextUpload: 'has no build context upload',
} as const satisfies Record<ImpdFeature, string>;

export interface FeatureSource {
  readonly system: {
    readonly features: (input?: undefined, options?: CallOptions) => Promise<SystemFeaturesInfo>;
    readonly info: (input?: undefined, options?: CallOptions) => Promise<SystemInfo>;
  };
}

export type FeatureNeeds = Partial<Readonly<Record<ImpdFeature, string>>>;

export class MissingFeatureError extends Error {
  override name = 'MissingFeatureError';

  readonly feature: ImpdFeature;

  readonly gap: string;

  readonly outcome: string;

  constructor(feature: ImpdFeature, gap: string, outcome: string) {
    super(`this impd ${gap} and would ${outcome}; nothing was changed`);

    this.feature = feature;
    this.gap = gap;
    this.outcome = outcome;
  }
}

export async function requireFeatures(
  client: FeatureSource,
  needs: FeatureNeeds,
  options: CallOptions = {},
): Promise<void> {
  if (Object.keys(needs).length === 0) {
    return;
  }

  const features = await readFeatures(client, options);

  for (const [feature, outcome] of Object.entries(needs)) {
    if (isImpdFeature(feature) && outcome !== undefined && features[feature] !== true) {
      throw new MissingFeatureError(feature, FEATURE_GAPS[feature], outcome);
    }
  }
}

export async function readFeatures(
  client: FeatureSource,
  options: CallOptions = {},
): Promise<Partial<ImpdFeatures>> {
  try {
    // The client does not check answers, and one with no flags has none on.
    const answer: Partial<SystemFeaturesInfo> = await client.system.features(undefined, options);

    return answer.features ?? {};
  } catch (error) {
    if (!isMissingProcedure(error)) {
      throw error;
    }
  }

  // An impd without the features call carries the flags in its info, or none.
  const info = await client.system.info(undefined, options);

  return info.features ?? {};
}

export function collectMissingFeatures(
  info: Pick<SystemInfo, 'features'>,
  wanted: readonly ImpdFeature[],
): ImpdFeature[] {
  return wanted.filter((feature) => info.features?.[feature] !== true);
}

function isMissingProcedure(error: unknown): boolean {
  return (
    error instanceof UnknownProcedureError || (error instanceof ORPCError && error.status === 404)
  );
}

function isImpdFeature(key: string): key is ImpdFeature {
  return Object.hasOwn(FEATURE_GAPS, key);
}
