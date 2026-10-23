import { readFileSync } from 'node:fs';
import { ImpdError } from '../../platform/errors/impd-error';
import { buildExitError, runCommand } from '../../platform/process/run-command';
import type { CommandResult } from '../../platform/process/run-command';

// CAP_SETFCAP's bit in /proc/<pid>/status (linux/capability.h).
const CAP_SETFCAP_BIT = 31n;
const SETFCAP_HELP = 'imp-host needs CAP_SETFCAP (docs/architecture/host.md#privileges)';

// GNU tar's `--xattrs` alone restores only `user.*`, and docker export writes file
// capabilities as `security.capability`. LC_ALL=C keeps tar's warnings in English.
export const UNPACK_TAR_ARGS = [
  'tar',
  '--numeric-owner',
  '--xattrs',
  '--xattrs-include=security.capability',
  '--xattrs-include=user.*',
  '-xpf',
  '-',
] as const;

const UNPACK_SCRIPT = `docker export "$1" | LC_ALL=C ${UNPACK_TAR_ARGS.map((arg) => `'${arg}'`).join(' ')} -C "$2"`;

export async function writeExportedTree(containerId: string, root: string): Promise<void> {
  const result = await runCommand([
    'bash',
    '-o',
    'pipefail',
    '-c',
    UNPACK_SCRIPT,
    'export',
    containerId,
    root,
  ]);

  assertUnpacked(result);
}

// tar only warns, and exits 0, when it cannot set an extended attribute, and a binary that
// lost its capability fails later in the imp with EPERM.
export function assertUnpacked(result: CommandResult): void {
  if (result.exitCode !== 0) {
    throw buildExitError(['docker', 'export', '|', 'tar'], result);
  }

  const failure = findXattrFailure(result.stderr);

  if (failure?.missingSetfcap === true) {
    throw new ImpdError('PRECONDITION_FAILED', {
      message: `the image has a file capability that impd could not keep (${failure.line}); ${SETFCAP_HELP}`,
    });
  }

  if (failure !== null) {
    throw new ImpdError('INTERNAL_SERVER_ERROR', {
      message: `the image has an extended attribute that impd could not keep: ${failure.line}`,
    });
  }
}

// GNU tar 1.35's warning for an attribute it could not set.
const XATTR_FAILURE =
  /Cannot set '(?<name>[^']+)' extended attribute for file '.*': (?<reason>[^:]+)$/u;

interface XattrFailure {
  readonly line: string;

  readonly missingSetfcap: boolean;
}

function findXattrFailure(stderr: string): XattrFailure | null {
  const failures = stderr.split('\n').flatMap((text) => {
    const line = text.trim();
    const groups = XATTR_FAILURE.exec(line)?.groups;

    if (groups === undefined) {
      return [];
    }

    const missingSetfcap =
      groups['name'] === 'security.capability' && groups['reason'] === 'Operation not permitted';

    return [{ line, missingSetfcap }];
  });

  return failures.find((failure) => failure.missingSetfcap) ?? failures[0] ?? null;
}

export function readSetfcapWarning(
  status: string = readFileSync('/proc/self/status', 'utf8'),
): string | null {
  const effective = /^CapEff:\s*(?<mask>[0-9a-f]+)$/mu.exec(status)?.groups?.['mask'] ?? '0';

  if ((BigInt(`0x${effective}`) >> CAP_SETFCAP_BIT) & 1n) {
    return null;
  }

  return `impd: warning: no CAP_SETFCAP, so an image add or build fails on an image with a file capability; ${SETFCAP_HELP}`;
}
