import { NameSchema } from '@impz/api';
import * as z from 'zod';
import { parseImageReference } from '../docker-contract/parse-image-reference';

const MAX_NAME_LENGTH = 31;

export function deriveImageName(ref: string): string {
  const lastSegment = parseImageReference(ref).path.split('/').at(-1) ?? '';

  const name = lastSegment
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, '-')
    .replace(/^[^a-z]+/u, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/u, '');

  if (!NameSchema.safeParse(name).success) {
    throw new Error(`cannot derive an image name from ${ref}; pass a name`);
  }

  return name;
}

const OciConfigSchema = z
  .object({
    Env: z.array(z.string()).nullish(),
    WorkingDir: z.string().nullish(),
    User: z.string().nullish(),
  })
  .nullish();

export interface ImageRuntimeConfig {
  readonly env: readonly string[];
  readonly workdir: string;
  readonly user: string;
}

export function buildImageRuntimeConfig(ociConfig: unknown): ImageRuntimeConfig {
  const parsed = OciConfigSchema.parse(ociConfig);

  return {
    env: parsed?.Env ?? [],
    workdir: parsed?.WorkingDir ?? '',
    user: parsed?.User ?? '',
  };
}
