import { readFile } from 'node:fs/promises';
import { getErrorMessage } from '../../../platform/process/get-error-message';

export type DnsTokenSource =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'file'; readonly path: string };

export interface DnsTokenStatus {
  readonly isOk: boolean;

  readonly error: string | null;
  readonly at: number;
}

export interface DnsToken {
  readonly read: () => Promise<string>;

  readonly check: (() => Promise<DnsTokenStatus>) | null;
}

type ReadText = (path: string) => Promise<string>;

export function createDnsToken(
  source: DnsTokenSource,
  now: () => number,
  readText: ReadText = (path) => readFile(path, 'utf8'),
): DnsToken {
  if (source.kind === 'value') {
    return { read: () => Promise.resolve(source.value), check: null };
  }

  const read = (): Promise<string> => readTokenFile(source.path, readText);

  return {
    read,
    check: async () => {
      try {
        await read();

        return { isOk: true, error: null, at: now() };
      } catch (error) {
        return { isOk: false, error: getErrorMessage(error), at: now() };
      }
    },
  };
}

const TOKEN_PATTERN = /^[\w.~+/-]+$/u;

// Every message names the file, never what it holds: a token with a stray
// character inside is still most of a secret.
async function readTokenFile(path: string, readText: ReadText): Promise<string> {
  let text: string;

  try {
    text = await readText(path);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';

    throw new Error(`cannot read the DNS API token from ${path}: ${code}`, { cause: error });
  }

  const token = text.trim();

  if (token === '') {
    throw new Error(`the DNS API token file ${path} is empty`);
  }

  // a byte a header refuses would put the token into fetch's own error message
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      `the DNS API token file ${path} holds characters no token has, such as whitespace, '=' or a NUL byte`,
    );
  }

  return token;
}
