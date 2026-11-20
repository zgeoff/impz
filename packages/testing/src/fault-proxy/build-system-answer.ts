import { isRecord } from './is-record';

interface SystemOverrides {
  readonly version?: string;
  readonly features?: Readonly<Record<string, boolean>>;
}

// system.info and system.features answer with the version, and system.features with the feature flags too
export function buildSystemAnswer(text: string, overrides: Readonly<SystemOverrides>): string {
  const parsed: unknown = JSON.parse(text);

  if (!isRecord(parsed) || !isRecord(parsed['json'])) {
    return text;
  }

  const json = parsed['json'];
  const features = json['features'];

  return JSON.stringify({
    ...parsed,
    json: {
      ...json,
      ...(overrides.version !== undefined && { version: overrides.version }),
      ...(overrides.features !== undefined &&
        isRecord(features) && { features: { ...features, ...overrides.features } }),
    },
  });
}
