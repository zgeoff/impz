import { faker } from '@faker-js/faker';
import { SESSION_MAX_AGE_S } from '@impz/daemon/src/identity/auth/session-cookie';
import { Collection } from '@msw/data';
import * as z from 'zod';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Bun's fetch keeps no cookies, so the session cookie of the one browser a
// test drives lives here
const SessionRowSchema = z.object({
  tokenId: z.string().default(() => faker.string.fromCharacters(BASE64URL, 16)),
  expiresAt: z.date().default(() => new Date(Date.now() + SESSION_MAX_AGE_S * 1000)),
});

export const sessionCollection = new Collection({ schema: SessionRowSchema });
