import * as z from 'zod';
import { ApiActorSchema } from './api-call-schema';
import { NameSchema } from './name-schema';
import { SecretNameSchema } from './secret-schema';

export const ScopeSchema = z.enum(['read', 'exec', 'manage']);

export type Scope = z.infer<typeof ScopeSchema>;

export const ImpPatternSchema = z
  .string()
  .regex(
    /^[a-z*][a-z0-9*-]{0,30}$/u,
    'must be an imp name, with * for any run of characters, such as dev-*',
  );

export const MAX_SSH_KEYS = 16;
const MAX_GRANTABLE = 32;

export const GrantableUpdateSchema = z
  .array(SecretNameSchema)
  .max(MAX_GRANTABLE)
  .refine((names) => new Set(names).size === names.length, 'must not name a secret twice');

export const GrantableSchema = GrantableUpdateSchema.min(1);

// The host needs a dot, a port or to be localhost, or docker would read the
// ref as one on Docker Hub.
export const ImageRefPrefixSchema = z
  .string()
  .max(200)
  .regex(
    /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]+)?|[a-z0-9-]+:[0-9]+|localhost)\/[a-z0-9][a-z0-9._/-]*$/u,
    'must be a registry host and the start of a path, such as ghcr.io/org/app-',
  );

export const SshPublicKeySchema = z.string().trim().min(1).max(16_384);

export const SshKeySchema = z.object({
  fingerprint: z.string(),
  type: z.string(),
  comment: z.string(),
});

export type SshKey = z.infer<typeof SshKeySchema>;

export const TokenSchema = z.object({
  name: NameSchema,
  scope: ScopeSchema,

  imps: z.array(ImpPatternSchema).readonly().nullable(),

  sshKeys: z.array(SshKeySchema).readonly(),

  grantable: z.array(SecretNameSchema).readonly().default([]),

  imageRefPrefix: ImageRefPrefixSchema.nullable().default(null),
  createdAt: z.date(),
});

export type Token = z.infer<typeof TokenSchema>;

export const IdentitySchema = z.object({
  kind: ApiActorSchema,
  name: z.string(),
  scope: ScopeSchema,
  imps: z.array(ImpPatternSchema).readonly().nullable(),
  grantable: z.array(SecretNameSchema).readonly().default([]),
  imageRefPrefix: ImageRefPrefixSchema.nullable().default(null),
});

export type Identity = z.infer<typeof IdentitySchema>;
