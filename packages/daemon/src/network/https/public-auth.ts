import type { PublicImp } from '../../platform/db/exposure';
import type { StoredPublicAuth } from '../../platform/db/imps';
import { hashSecret } from '../../platform/secrets/hash-secret';
import { isSameDigest } from '../../platform/secrets/is-same-digest';
import type { ProxyRoute } from '../proxy/wake-proxy';
import type { ListenerScope } from './https-listeners';
import type { PublicLimits } from './public-limits';

export function buildCredentialHash(credential: string): string {
  return hashSecret(credential).toString('base64url');
}

export function createPublicScope(
  findPublicImp: (name: string) => Promise<PublicImp | undefined>,
  limits: PublicLimits,
): ListenerScope {
  return {
    kind: 'public',
    routeImp: createPublicRoute(findPublicImp, limits),
    probePublic: async (name) => {
      const found = await findPublicImp(name);

      return found !== undefined;
    },
  };
}

export function createPublicRoute(
  findPublicImp: (name: string) => Promise<PublicImp | undefined>,
  limits: PublicLimits,
): (name: string, request: Request) => Promise<ProxyRoute | null> {
  return async (name, request) => {
    const found = await findPublicImp(name);

    if (found === undefined) {
      return null;
    }

    const stored = found.stored;
    const authorization = request.headers.get('authorization');
    const scheme = stored.auth === 'token' ? 'Bearer' : 'Basic';
    const challenge = `${scheme} realm="${name}", charset="UTF-8"`;

    // No credential at all is a browser before its password prompt: it
    // always gets the challenge, and counts against no limit, so a stranger
    // cannot block the prompt.
    if (stored.auth !== 'none' && authorization === null) {
      return { kind: 'unauthorized', challenge };
    }

    if (!checkCredential(stored, authorization)) {
      if (!limits.tryFail(found.id)) {
        return buildLimited(
          'Too many failed sign-ins; try again later.',
          limits.readRetryS('failure'),
        );
      }

      return { kind: 'unauthorized', challenge };
    }

    const release = limits.tryOpen(found.id);

    if (release === null) {
      return buildLimited('Too many open requests to this site.', 1);
    }

    if (found.state !== 'running' && !limits.tryWake(found.id)) {
      release();

      return buildLimited('This site woke too often; try again later.', limits.readRetryS('wake'));
    }

    return {
      kind: 'imp',
      name,
      public: { dropAuthorization: stored.auth !== 'none', release },
    };
  };
}

function buildLimited(detail: string, retryAfterS: number): ProxyRoute {
  return { kind: 'limited', detail, retryAfterS };
}

function checkCredential(stored: StoredPublicAuth, authorization: string | null): boolean {
  if (stored.auth === 'none') {
    return true;
  }

  const presented = readPresented(stored, authorization);

  if (presented === null || stored.hash === null) {
    return false;
  }

  // the user name as sha256 digests too, so its length leaks no timing
  const isUser =
    stored.auth !== 'basic' ||
    isSameDigest(hashSecret(presented.user ?? ''), hashSecret(stored.user ?? ''));

  const isSecret = isSameDigest(
    hashSecret(presented.secret),
    Buffer.from(stored.hash, 'base64url'),
  );

  return isUser && isSecret;
}

interface Presented {
  readonly user: string | null;
  readonly secret: string;
}

function readPresented(stored: StoredPublicAuth, authorization: string | null): Presented | null {
  const match = /^(?<scheme>\S+) +(?<value>\S+)$/u.exec(authorization?.trim() ?? '')?.groups;
  const scheme = match?.['scheme']?.toLowerCase();
  const value = match?.['value'];

  if (value === undefined) {
    return null;
  }

  if (stored.auth === 'token') {
    return scheme === 'bearer' ? { user: null, secret: value } : null;
  }

  if (scheme !== 'basic') {
    return null;
  }

  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');

  return colon === -1 ? null : { user: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}
