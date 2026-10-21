import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface StubNftBinOptions {
  readonly stderr?: string;
  readonly exitCode?: number;
}

export async function createStubNftBin(
  directory: string,
  options: Readonly<StubNftBinOptions> = {},
) {
  const path = join(directory, 'nft');
  const argvPath = join(directory, 'nft-argv');
  const stdinPath = join(directory, 'nft-stdin');

  await writeFile(
    path,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" > ${formatShellWord(argvPath)}`,
      `cat > ${formatShellWord(stdinPath)}`,
      `printf '%s' ${formatShellWord(options.stderr ?? '')} >&2`,
      `exit ${String(options.exitCode ?? 0)}`,
      '',
    ].join('\n'),
  );

  await chmod(path, 0o755);

  return {
    path,
    readArgv: (): Promise<string> => readFile(argvPath, 'utf8'),
    readStdin: (): Promise<string> => readFile(stdinPath, 'utf8'),
  };
}

function formatShellWord(text: string): string {
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}
