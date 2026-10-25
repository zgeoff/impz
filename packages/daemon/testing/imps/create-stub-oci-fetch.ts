import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';

export type StubOciFetchAnswer = 'ok' | 'hang' | { readonly stderr: string };

interface StubOciImage {
  readonly ref: string;
  readonly digest: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly exportTar?: Uint8Array;
  readonly fetch?: StubOciFetchAnswer;
}

export interface StubOciFetchOptions {
  readonly directory: string;
  readonly images?: readonly StubOciImage[];
}

export function createStubOciFetch(options: Readonly<StubOciFetchOptions>) {
  const bin = join(options.directory, 'bin');
  const state = join(options.directory, 'stub-oci-fetch');
  const log = join(state, 'calls.log');
  const arms: string[] = [];

  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });

  for (const [index, image] of (options.images ?? []).entries()) {
    const config = join(state, `config-${String(index)}.json`);

    writeFileSync(
      config,
      `${JSON.stringify({ digest: image.digest, config: image.config ?? {} })}\n`,
    );

    arms.push(buildConfigArm(`config ${image.ref}`, config, image.fetch ?? 'ok', state));

    if (image.exportTar !== undefined) {
      const tar = join(state, `export-${String(index)}.tar`);

      writeFileSync(tar, image.exportTar);

      arms.push(`  ${formatShellWord(`export ${image.ref}`)}) cat ${formatShellWord(tar)} ;;`);
    }
  }

  const script = [
    '#!/bin/sh',
    `echo "$*" >>${formatShellWord(log)}`,
    'case "$*" in',
    ...arms,
    `  *) echo "oci-fetch: fetch $2: MANIFEST_UNKNOWN: manifest unknown" >&2; exit 1 ;;`,
    'esac',
    '',
  ].join('\n');

  const ociFetch = join(bin, 'oci-fetch');

  writeFileSync(ociFetch, script);
  chmodSync(ociFetch, 0o755);

  return {
    bin,

    path: `${bin}:${process.env['PATH'] ?? ''}`,

    readCalls: (): string[] =>
      existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : [],
  };
}

function buildConfigArm(
  argv: string,
  config: string,
  answer: StubOciFetchAnswer,
  state: string,
): string {
  const pattern = formatShellWord(argv);

  if (answer === 'ok') {
    return `  ${pattern}) cat ${formatShellWord(config)} ;;`;
  }

  // The fetch holds until the stub's directory goes, so a test's cleanup ends it.
  if (answer === 'hang') {
    return `  ${pattern}) while [ -d ${formatShellWord(state)} ]; do sleep 0.05; done; exit 1 ;;`;
  }

  return `  ${pattern}) printf '%s\\n' ${formatShellWord(answer.stderr)} >&2; exit 1 ;;`;
}
