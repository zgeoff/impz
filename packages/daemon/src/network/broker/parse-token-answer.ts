import * as z from 'zod';
import { isHeaderSafeToken } from './oauth-state';

export interface TokenResponse {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresInMs: number | null;
}

export type Classified =
  | { readonly kind: 'ok'; readonly tokens: TokenResponse }
  | { readonly kind: 'transient'; readonly error: string }
  | { readonly kind: 'permanent'; readonly error: string };

export function parseTokenAnswer(status: number, text: string): Classified {
  let body: unknown = null;

  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  const code = findErrorCode(body);

  const PERMANENT_CODES = new Set([
    'invalid_grant',
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
  ]);

  if (code !== null && PERMANENT_CODES.has(code)) {
    return { kind: 'permanent', error: code };
  }

  if (status === 401) {
    return { kind: 'permanent', error: code ?? 'HTTP 401' };
  }

  if (status < 200 || status >= 300) {
    return { kind: 'transient', error: `HTTP ${String(status)}` };
  }

  return parseTokens(body);
}

const ErrorObjectSchema = z.object({ code: z.string().nullish(), error: z.string().nullish() });
const ErrorAnswerSchema = z.object({ error: z.union([z.string(), ErrorObjectSchema]) });

function findErrorCode(body: unknown): string | null {
  const parsed = ErrorAnswerSchema.safeParse(body);

  if (!parsed.success) {
    return null;
  }

  const error = parsed.data.error;
  const code = typeof error === 'string' ? error : (error.code ?? error.error);

  return code !== null && code !== undefined && /^[A-Za-z0-9_.-]{1,64}$/u.test(code) ? code : null;
}

const TokenAnswerSchema = z.object({
  access_token: z.string().nullish(),
  refresh_token: z.string().nullish(),
  id_token: z.string().nullish(),
  expires_in: z.number().nullish(),
});

function parseTokens(body: unknown): Classified {
  const parsed = TokenAnswerSchema.safeParse(body);

  if (!parsed.success) {
    return { kind: 'transient', error: 'invalid response' };
  }

  const accessToken = parsed.data.access_token ?? null;
  const refreshToken = parsed.data.refresh_token ?? null;
  const idToken = parsed.data.id_token ?? null;

  const unusable = [accessToken, refreshToken, idToken].some(
    (token) => token !== null && !isHeaderSafeToken(token),
  );

  if (unusable) {
    return { kind: 'transient', error: 'invalid response' };
  }

  if (accessToken === null && refreshToken === null) {
    return { kind: 'transient', error: 'no token in the response' };
  }

  const expiresIn = parsed.data.expires_in ?? null;
  const expiresInMs = expiresIn === null ? null : Math.max(0, expiresIn) * 1000;

  return { kind: 'ok', tokens: { accessToken, refreshToken, idToken, expiresInMs } };
}
