import { oc } from '@orpc/contract';
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
import { IMP_ERRORS } from './imp-errors';

const base = oc.errors(IMP_ERRORS);

// named API tokens (docs/guides/tokens.md); the root token in
// <dataDir>/token is not one of them
export const tokensContract = {
  list: base.output(z.array(TokenSchema)),

  // the secret is in the answer once and never again
  create: base
    .input(
      z.object({
        name: NameSchema,
        scope: ScopeSchema,
        imps: z.array(ImpPatternSchema).min(1).max(32).optional(),
        sshKeys: z.array(SshPublicKeySchema).min(1).max(MAX_SSH_KEYS).optional(),

        // existing secrets it may grant to its imps; needs manage and imps
        grantable: GrantableSchema.optional(),

        // the ref start of the images it may add under its imp patterns,
        // pinned by digest (docs/guides/tokens.md#adding-images); needs
        // manage and imps
        imageRefPrefix: ImageRefPrefixSchema.optional(),
      }),
    )
    .output(z.object({ token: TokenSchema, secret: z.string() })),

  // sets its grantable list, its image ref prefix (null for none), or both;
  // the rest stays (docs/guides/tokens.md#change-the-list). BAD_REQUEST for
  // either without manage and imps; NOT_FOUND for the token or a secret.
  update: base
    .input(
      z
        .object({
          name: NameSchema,
          grantable: GrantableUpdateSchema.optional(),

          // an older impd needs `grantable`: check features.tokenImageAdd
          // before leaving it out
          imageRefPrefix: ImageRefPrefixSchema.nullable().optional(),
        })
        .refine(
          (input) => input.grantable !== undefined || input.imageRefPrefix !== undefined,
          'must set grantable, imageRefPrefix or both',
        ),
    )
    .output(TokenSchema),

  // ends its dashboard sessions, event streams, sockets and ssh logins too;
  // CONFLICT while authorized_keys lists one of its keys
  delete: base.input(NameInputSchema).output(EmptySchema),

  // binds an SSH key, so a login with it runs as the token; CONFLICT for a
  // key bound to any token or listed in authorized_keys
  addKey: base.input(z.object({ name: NameSchema, key: SshPublicKeySchema })).output(SshKeySchema),

  // ends the ssh logins made with the key; CONFLICT while authorized_keys
  // lists it, since unbinding would hand it every imp
  removeKey: base
    .input(z.object({ name: NameSchema, fingerprint: z.string() }))
    .output(EmptySchema),

  // who the caller is, and what it may do
  whoami: base.output(IdentitySchema),
};
