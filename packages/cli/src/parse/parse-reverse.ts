import type { ReverseGuest } from '@impz/client';
import { UsageError } from '../cli/errors';

export type ReverseLocal =
  | { readonly network: 'unix'; readonly path: string }
  | { readonly network: 'tcp'; readonly port: number };

export interface ReverseSpec {
  readonly guest: ReverseGuest;
  readonly local: ReverseLocal;
}

const USAGE =
  'try GUEST:LOCAL, each an absolute path or a port: /tmp/app.sock:/run/app.sock, 9000:8080, or 9000';

export function parseReverse(spec: string): ReverseSpec {
  const colon = spec.indexOf(':');
  const guestText = colon === -1 ? spec : spec.slice(0, colon);
  const localText = colon === -1 ? spec : spec.slice(colon + 1);
  const guest = parseGuest(guestText);
  const local = parseLocal(localText);

  if (guest === null || local === null || (colon === -1 && spec === '')) {
    throw new UsageError(`not a reverse forward: ${spec} (${USAGE})`);
  }

  return { guest, local };
}

function parseGuest(text: string): ReverseGuest | null {
  if (text === '') {
    return { network: 'unix', path: null };
  }

  if (text.startsWith('/')) {
    return { network: 'unix', path: text };
  }

  const port = parsePort(text, 0);

  return port === null ? null : { network: 'tcp', port };
}

const MAX_PORT = 65_535;

function parsePort(text: string, min: number): number | null {
  const port = /^\d+$/u.test(text) ? Number(text) : Number.NaN;

  return port >= min && port <= MAX_PORT ? port : null;
}

function parseLocal(text: string): ReverseLocal | null {
  if (text.startsWith('/')) {
    return { network: 'unix', path: text };
  }

  const port = parsePort(text, 1);

  return port === null ? null : { network: 'tcp', port };
}
