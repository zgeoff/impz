import * as z from 'zod';
import { EmptySchema } from '../schemas/empty-schema';
import { NameInputSchema } from '../schemas/name-input-schema';
import { NameSchema } from '../schemas/name-schema';
import {
  GrantableSchema,
  GrantableUpdateSchema,
  IdentitySchema,
  ImageRefPrefixSchema,
  ImpPatternSchema,
  MAX_SSH_KEYS,
  ScopeSchema,
  SshKeySchema,
  SshPublicKeySchema,
  TokenSchema,
} from '../schemas/token-schema';
import { ACCESS } from './access';
import { contractBase as base } from './contract-base';

export const tokensContract = {
  list: base.meta(ACCESS.manageHost).output(z.array(TokenSchema)),

  // This answer holds the token's secret, and no later call returns it.
  create: base
    .meta(ACCESS.manageHost)
    .input(
      z.object({
        name: NameSchema,
        scope: ScopeSchema,
        imps: z.array(ImpPatternSchema).min(1).max(32).optional(),
        sshKeys: z.array(SshPublicKeySchema).min(1).max(MAX_SSH_KEYS).optional(),

        grantable: GrantableSchema.optional(),

        imageRefPrefix: ImageRefPrefixSchema.optional(),
      }),
    )
    .output(z.object({ token: TokenSchema, secret: z.string() })),

  update: base
    .meta(ACCESS.manageHost)
    .input(
      z
        .object({
          name: NameSchema,
          grantable: GrantableUpdateSchema.optional(),

          imageRefPrefix: ImageRefPrefixSchema.nullable().optional(),
        })
        .refine(
          (input) => input.grantable !== undefined || input.imageRefPrefix !== undefined,
          'must set grantable, imageRefPrefix or both',
        ),
    )
    .output(TokenSchema),

  delete: base.meta(ACCESS.manageHost).input(NameInputSchema).output(EmptySchema),

  addKey: base
    .meta(ACCESS.manageHost)
    .input(z.object({ name: NameSchema, key: SshPublicKeySchema }))
    .output(SshKeySchema),

  removeKey: base
    .meta(ACCESS.manageHost)
    .input(z.object({ name: NameSchema, fingerprint: z.string() }))
    .output(EmptySchema),

  whoami: base.meta(ACCESS.readAny).output(IdentitySchema),
};
