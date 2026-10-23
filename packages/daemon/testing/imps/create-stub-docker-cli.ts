import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { PIN_INSPECT_FORMAT } from '../../src/imps/images/image-pin';

interface StubDockerInspect {
  readonly Id: string;
  readonly RepoDigests?: readonly string[];
  readonly Os?: string;
  readonly Architecture?: string;
  readonly Config?: unknown;
  readonly Size?: number;
}

export type StubDockerPull = 'ok' | 'lost' | 'hang' | { readonly stderr: string };

export interface StubDockerImage {
  readonly refs: readonly string[];
  readonly inspects: readonly StubDockerInspect[];
  readonly isOnHost?: boolean;
  readonly pull?: StubDockerPull;
}

export interface StubDockerCliOptions {
  readonly directory: string;
  readonly version?: { readonly os: string; readonly arch: string } | { readonly stdout: string };
  readonly images?: readonly StubDockerImage[];
  readonly create?: { readonly id: string } | { readonly stderr: string };
  readonly exportTar?: Uint8Array;
}

const FORMATS: ReadonlyMap<string, (inspect: StubDockerInspect) => string> = new Map([
  ['', (inspect: StubDockerInspect) => JSON.stringify([inspect])],
  ['{{.Id}}', (inspect: StubDockerInspect) => inspect.Id],
  ['{{json .Config}}', (inspect: StubDockerInspect) => JSON.stringify(inspect.Config ?? null)],
  [
    PIN_INSPECT_FORMAT,
    (inspect: StubDockerInspect) =>
      JSON.stringify({
        Id: inspect.Id,
        RepoDigests: inspect.RepoDigests ?? [],
        Os: inspect.Os ?? 'linux',
        Architecture: inspect.Architecture ?? 'amd64',
        Config: inspect.Config ?? null,
      }),
  ],
]);

export function createStubDockerCli(options: Readonly<StubDockerCliOptions>) {
  const bin = join(options.directory, 'bin');
  const state = join(options.directory, 'stub-docker');
  const log = join(state, 'calls.log');
  const version = options.version ?? { os: 'linux', arch: 'x86_64' };
  const versionLine = 'stdout' in version ? version.stdout : `"${version.os}" "${version.arch}"`;
  const arms: string[] = [];

  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });

  for (const [index, image] of (options.images ?? []).entries()) {
    for (const [sequence, inspect] of image.inspects.entries()) {
      for (const [formatKey, render] of [...FORMATS.values()].entries()) {
        writeFileSync(
          join(state, `inspect-${String(index)}-${String(sequence)}-${String(formatKey)}`),
          `${render(inspect)}\n`,
        );
      }
    }

    for (const ref of image.refs) {
      for (const format of FORMATS.keys()) {
        const argv =
          format === '' ? `image inspect ${ref}` : `image inspect --format ${format} ${ref}`;

        arms.push(buildInspectArm({ index, image, argv, format, state }));
      }

      arms.push(buildPullArm(index, ref, image.pull ?? 'ok', state));
    }
  }

  const create = options.create;

  if (create !== undefined && 'id' in create) {
    arms.push(`  'create '*) echo ${formatShellWord(create.id)} ;;`);
  }

  if (create !== undefined && 'stderr' in create) {
    arms.push(`  'create '*) printf '%s\\n' ${formatShellWord(create.stderr)} >&2; exit 1 ;;`);
  }

  if (options.exportTar !== undefined) {
    writeFileSync(join(state, 'export.tar'), options.exportTar);

    arms.push(`  'export '*) cat ${formatShellWord(join(state, 'export.tar'))} ;;`);
  }

  const script = [
    '#!/bin/sh',
    `echo "$*" >>${formatShellWord(log)}`,
    'for last; do :; done',
    'case "$*" in',
    `  'version --format '*) echo ${formatShellWord(versionLine)} ;;`,
    ...arms,
    `  'rm -f '*) echo "$last" ;;`,
    `  *) echo "stub docker: $* is not modelled" >&2; exit 1 ;;`,
    'esac',
    '',
  ].join('\n');

  const docker = join(bin, 'docker');

  writeFileSync(docker, script);
  chmodSync(docker, 0o755);

  return {
    bin,

    path: `${bin}:${process.env['PATH'] ?? ''}`,

    readCalls: (): string[] =>
      existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : [],
  };
}

interface BuildInspectArmOptions {
  readonly index: number;
  readonly image: StubDockerImage;
  readonly argv: string;
  readonly format: string;
  readonly state: string;
}

// Each call appends a line to the count, because a count rewritten in place reads empty to
// a parallel call.
function buildInspectArm(options: BuildInspectArmOptions): string {
  const image = options.image;
  const state = options.state;
  const tag = String(options.index);
  const count = formatShellWord(join(state, `inspected-${tag}`));
  const last = String(image.inspects.length - 1);
  const output = formatShellWord(join(state, `inspect-${tag}-`));
  const formatKey = String([...FORMATS.keys()].indexOf(options.format));

  const present =
    image.isOnHost === false
      ? `[ -e ${formatShellWord(join(state, `pulled-${tag}`))} ] || { echo "Error: No such image: $last" >&2; exit 1; }; `
      : '';

  return [
    `  ${formatShellWord(options.argv)}) ${present}echo >>${count}; n=$(($(wc -l <${count}) - 1))`,
    `    [ "$n" -gt ${last} ] && n=${last}; cat ${output}"$n"-${formatKey} ;;`,
  ].join('\n');
}

function buildPullArm(index: number, ref: string, pull: StubDockerPull, state: string): string {
  if (pull === 'hang') {
    return `  ${formatShellWord(`pull --quiet ${ref}`)}) while [ -d ${formatShellWord(state)} ]; do sleep 0.05; done; exit 1 ;;`;
  }

  if (pull === 'lost') {
    return `  ${formatShellWord(`pull --quiet ${ref}`)}) echo ${formatShellWord(ref)} ;;`;
  }

  if (pull === 'ok') {
    return `  ${formatShellWord(`pull --quiet ${ref}`)}) touch ${formatShellWord(join(state, `pulled-${String(index)}`))}; echo ${formatShellWord(ref)} ;;`;
  }

  return `  ${formatShellWord(`pull --quiet ${ref}`)}) printf '%s\\n' ${formatShellWord(pull.stderr)} >&2; exit 1 ;;`;
}
