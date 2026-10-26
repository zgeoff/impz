import { parseArgs } from 'node:util';
import { match } from 'ts-pattern';
import { DistroSchema } from './distros';
import type { Distro } from './distros';

export const BOOTSTRAP_USAGE = `Run deploy/bootstrap.sh for real inside a throwaway container with systemd
as PID 1, on Debian 13 and Ubuntu 24.04 and 26.04, and check that a second run
changes nothing.

  e2e/test-bootstrap.sh --image imp-host:<tag>   a local release image
  e2e/test-bootstrap.sh --stub                   a stand-in image (CI)
  e2e/test-bootstrap.sh --image ... --health     also create and exec an imp (needs KVM)
  e2e/test-bootstrap.sh --distro debian ...      one distro only
  e2e/test-bootstrap.sh --keep ...               leave a failed container to inspect
  e2e/test-bootstrap.sh --zfs ...                also a real ZFS run on Ubuntu 24.04 (needs
                                                     the zfs module loaded on this host)`;

export interface BootstrapArgs {
  readonly image: string | null;
  readonly stub: boolean;
  readonly health: boolean;
  readonly keep: boolean;
  readonly zfs: boolean;
  readonly distros: readonly Distro[];
}

type ParsedBootstrapArgs =
  | { readonly kind: 'run'; readonly args: BootstrapArgs }
  | { readonly kind: 'help' }
  | { readonly kind: 'refused'; readonly reason: string };

const FLAGS = ['stub', 'health', 'keep', 'zfs', 'help'] as const;

type Flag = (typeof FLAGS)[number];

export function parseBootstrapArgs(argv: readonly string[]): ParsedBootstrapArgs {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      image: { type: 'string' },
      distro: { type: 'string' },
      stub: { type: 'boolean' },
      health: { type: 'boolean' },
      keep: { type: 'boolean' },
      zfs: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },

    // Not strict, so the tokens arrive in order and the first bad one names itself.
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  let image: string | null = null;
  let distros: readonly Distro[] = DistroSchema.options;

  const flags = new Set<Flag>();

  for (const token of parsed.tokens) {
    if (token.kind === 'positional') {
      return refuse(`unknown argument: ${token.value}`);
    }

    if (token.kind === 'option-terminator') {
      return refuse('unknown argument: --');
    }

    const value = token.value ?? '';

    if (token.name === 'image') {
      if (value === '') {
        return refuse('--image needs a reference');
      }

      image = value;
    } else if (token.name === 'distro') {
      const distro = DistroSchema.safeParse(value);

      if (!distro.success) {
        return refuse('--distro needs debian, ubuntu24 or ubuntu26');
      }

      distros = [distro.data];
    } else {
      const flag = FLAGS.find((name) => name === token.name);

      if (flag === undefined || token.value !== undefined) {
        const raw = token.value === undefined ? token.rawName : `${token.rawName}=${token.value}`;

        return refuse(`unknown argument: ${raw}`);
      }

      flags.add(flag);
    }
  }

  return pickOutcome({ image, distros, flags });
}

function refuse(reason: string): ParsedBootstrapArgs {
  return { kind: 'refused', reason };
}

interface Collected {
  readonly image: string | null;
  readonly distros: readonly Distro[];
  readonly flags: ReadonlySet<Flag>;
}

function pickOutcome(collected: Collected): ParsedBootstrapArgs {
  const args: BootstrapArgs = {
    image: collected.image,
    stub: collected.flags.has('stub'),
    health: collected.flags.has('health'),
    keep: collected.flags.has('keep'),
    zfs: collected.flags.has('zfs'),
    distros: collected.distros,
  };

  return match({ help: collected.flags.has('help'), args })
    .with({ help: true }, (): ParsedBootstrapArgs => ({ kind: 'help' }))
    .with({ args: { image: null, stub: false } }, () => refuse('give --image REF or --stub'))
    .with({ args: { stub: true, health: true } }, () => refuse('--health needs a real --image'))
    .otherwise((): ParsedBootstrapArgs => ({ kind: 'run', args }));
}
