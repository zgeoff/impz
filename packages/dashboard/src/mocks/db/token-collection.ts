import { faker } from '@faker-js/faker';
import { TokenSchema } from '@impz/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const TokenRowSchema = TokenSchema.extend({
  name: TokenSchema.shape.name.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  scope: TokenSchema.shape.scope.default('manage'),
  imps: TokenSchema.shape.imps.default(null),
  sshKeys: TokenSchema.shape.sshKeys.default([]),
  createdAt: z.date().default(() => faker.date.past()),

  // impd's token format: 12 and 32 random bytes in base64url
  secret: z.string().default(() => {
    const id = faker.string.fromCharacters(BASE64URL, 16);
    const secret = faker.string.fromCharacters(BASE64URL, 43);

    return `imp_${id}.${secret}`;
  }),
});

export const tokenCollection = new Collection({ schema: TokenRowSchema });

export function readTokenId(secret: string): string {
  return secret.slice('imp_'.length, secret.indexOf('.'));
}
